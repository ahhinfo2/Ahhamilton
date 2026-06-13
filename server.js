// ── Gestionnaires d'erreurs globaux (debug production) ────────────────────
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Stripe   = require('stripe');

// Créer les dossiers uploads au démarrage
['uploads','uploads/gallery','uploads/profiles','uploads/invoices',
 'uploads/payments','uploads/talents','uploads/annonces','uploads/attachments','uploads/activities','uploads/qr']
  .forEach(d => { const p = path.join(__dirname, d); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); });

const db = require('./db/database');
const { authMiddleware, requireRole, JWT_SECRET } = require('./middleware/auth');
const mailer = require('./mailer');
const imap   = require('./imap');

const app  = express();
const PORT = process.env.PORT || 3001;
console.log(`Starting AHH server on PORT=${PORT}`);

// ── SSE — connexions temps réel ───────────────────────────────────────────
const sseClients = new Map(); // userId → Set<Response>

function sseNotify(userIds, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const targets = userIds === 'all'
    ? [...sseClients.values()]
    : (Array.isArray(userIds) ? userIds : [userIds]).map(id => sseClients.get(id)).filter(Boolean);
  targets.forEach(set => set?.forEach(res => { try { res.write(data); } catch(_) {} }));
}

// ── Webhook Stripe (corps brut — AVANT express.json) ─────────────────────
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  res.json({ received: true });
  console.log('=== STRIPE WEBHOOK REÇU ===');

  const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  console.log('STRIPE_KEY défini:', !!stripeKey, 'longueur:', stripeKey.length);

  let event;
  try {
    const bodyStr = req.body ? req.body.toString('utf8') : '{}';
    console.log('Body (200 chars):', bodyStr.substring(0, 200));
    const parsed = JSON.parse(bodyStr);
    console.log('Event ID:', parsed.id, '| Type:', parsed.type, '| Has data.object:', !!(parsed.data && parsed.data.object));

    if (stripeKey && parsed.id && (!parsed.data || !parsed.data.object)) {
      console.log('Thin event — récupération via API Stripe...');
      try {
        const stripe = Stripe(stripeKey);
        event = await stripe.events.retrieve(parsed.id);
        console.log('Event récupéré:', event.type, '| Session ID:', event.data?.object?.id);
      } catch (e) {
        console.error('Erreur retrieve:', e.message);
        return;
      }
    } else if (parsed.data && parsed.data.object) {
      console.log('Event complet reçu directement');
      event = parsed;
    } else {
      console.error('Event invalide — ni thin ni complet, STRIPE_KEY manquant?');
      return;
    }
  } catch (err) {
    console.error('Parse error:', err.message);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const email    = session.customer_details?.email || session.metadata?.acheteur_email || '';
    const montant  = (session.amount_total || 0) / 100;
    const ref      = session.payment_intent || session.id;
    const mois     = new Date().toISOString().substring(0, 7);

    // ── Achat de billets ───────────────────────────────────────────────
    if (session.metadata?.type === 'billet' && session.metadata?.order_token) {
      const orderToken = session.metadata.order_token;
      const actId = parseInt(session.metadata.activity_id);
      db.prepare("UPDATE tickets SET statut='actif', payment_status='paid' WHERE order_token=?").run(orderToken);
      const tickets = db.prepare('SELECT * FROM tickets WHERE order_token=?').all(orderToken);
      const act = db.prepare('SELECT * FROM activities WHERE id=?').get(actId);
      const prenom = session.metadata.acheteur_prenom || email;
      for (const t of tickets) {
        const ticketToken = (t.qr_data || '').replace('TICKET:', '');
        try {
          const qrUrl = `${process.env.SITE_URL || 'https://ahhamilton.ca'}/scan.html?t=${ticketToken}`;
          const qrBuf = await QRCode.toBuffer(qrUrl, { type: 'png', width: 300, margin: 2 });
          const typeNom = t.ticket_type_id ? (db.prepare('SELECT nom FROM activity_ticket_types WHERE id=?').get(t.ticket_type_id)?.nom || '') : '';
          mailer.sendBilletQR(t.acheteur_email, prenom, act, { ...t, nom: typeNom, token: ticketToken }, qrBuf.toString('base64')).catch(() => {});
        } catch (e) { console.error('Stripe QR error:', e.message); }
      }
      // Enregistrer le revenu
      if (montant > 0) {
        const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id=? LIMIT 1').get(actId);
        if (line) {
          const adminId3 = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id || 1;
          db.prepare("INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par) VALUES (?, 'revenu', ?, ?, 'stripe', ?)")
            .run(line.id, montant, `Billets Stripe — ${email}`, adminId3);
          db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(montant);
        }
      }
      // Inscrire le membre dans activity_registrations s'il a un compte
      const membre = email ? db.prepare('SELECT id FROM users WHERE email = ? AND actif = 1').get(email) : null;
      if (membre && actId) {
        const existing = db.prepare('SELECT id FROM activity_registrations WHERE activity_id=? AND user_id=?').get(actId, membre.id);
        if (existing) {
          db.prepare("UPDATE activity_registrations SET statut='inscrit' WHERE id=?").run(existing.id);
        } else {
          db.prepare("INSERT INTO activity_registrations (activity_id, user_id, statut) VALUES (?,?,'inscrit')").run(actId, membre.id);
        }
      }
      console.log(`✅ Stripe billets activés : ${email} — ${tickets.length} billet(s) — $${montant}`);
      return;
    }
    // ──────────────────────────────────────────────────────────────────

    // Trouver le membre par courriel
    const membre = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    const userId = membre?.id || null;

    // Enregistrer comme paiement/don approuvé automatiquement
    const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id || 1;
    db.prepare(`INSERT INTO payments (user_id, montant, type, methode, reference, note, statut, date_soumission)
      VALUES (?, ?, 'don', 'stripe', ?, ?, 'approuve', CURRENT_TIMESTAMP)`)
      .run(userId, montant, ref, `Don Stripe — ${email}`);

    // Créer une alerte et un message pour la trésorière
    const finance = db.prepare("SELECT id FROM users WHERE role IN ('admin','tresoriere') AND actif=1").all();
    const msgText = `Don Stripe reçu — ${email} — $${montant.toFixed(2)}`;
    const msg = db.prepare("INSERT INTO messages (expediteur_id,sujet,contenu,type) VALUES (?,?,?,'individuel')")
      .run(adminId, `💳 Don Stripe $${montant.toFixed(2)} — ${email}`, msgText);
    finance.forEach(f => {
      db.prepare('INSERT INTO message_recipients (message_id,destinataire_id) VALUES (?,?)').run(msg.lastInsertRowid, f.id);
      createAlert(f.id, 'paiement', `💳 Don Stripe $${montant.toFixed(2)}`, email);
    });

    // Notifier le donateur si c'est un membre
    if (membre) {
      mailer.sendPaiementApprouve(membre, montant, mois).catch(() => {});
    }

    // Auto-générer un reçu fiscal si le montant est >= $1 et le membre est connu
    if (membre && montant >= 1) {
      const annee = new Date().getFullYear();
      const adminId2 = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id || 1;
      // Calculer total annuel incluant ce paiement
      const totalAnnuel = (db.prepare(`
        SELECT COALESCE(SUM(montant),0) AS total FROM payments
        WHERE user_id = ? AND statut = 'approuve' AND strftime('%Y', date_soumission) = ?
      `).get(membre.id, String(annee))?.total || 0);
      const contenu = `REÇU FISCAL ${annee}\nAssociation Haïtienne de Hamilton\n231 Fernwood Crescent, Hamilton, ON L8T 3L7\n\nRemis à : ${membre.prenom} ${membre.nom}\nCourriel : ${membre.email}\n\nDons et cotisations approuvés pour ${annee} : $${totalAnnuel.toFixed(2)}\n\nRéférence Stripe : ${ref}\n\nCe reçu confirme les contributions à l'Association Haïtienne de Hamilton pour l'année fiscale ${annee}.`;
      db.prepare(`INSERT INTO tax_receipts (user_id, annee, montant_total, genere_par, contenu, mode_emission, stripe_payment_id)
        VALUES (?,?,?,?,?,'stripe',?)`).run(membre.id, annee, totalAnnuel, adminId2, contenu, ref);
      createAlert(membre.id, 'paiement', `🧾 Reçu fiscal ${annee} disponible`, `Don Stripe $${montant.toFixed(2)} — Total annuel : $${totalAnnuel.toFixed(2)}`);
    }

    console.log(`✅ Stripe don enregistré : ${email} — $${montant}`);
  }
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

// sw.js et script.js servis sans cache pour que les mises à jour soient immédiates
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/script.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'script.js'));
});

// Bloquer les fichiers RAW (CR2, NEF, ARW…) — ne jamais servir publiquement
app.use('/Public', (req, res, next) => {
  if (/\.(cr2|cr3|nef|nrw|arw|raf|orf|dng|rw2|raw)$/i.test(req.path)) {
    return res.status(403).end();
  }
  next();
});

// Images publiques : cache 7 jours (doit être avant le handler racine)
app.use('/Public', express.static(path.join(__dirname, 'Public'), { maxAge: 604800000 }));

app.use('/', express.static(path.join(__dirname)));

// ── Multer : invoice photos ─────────────────────────────────────────────────
const invoiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads', 'invoices')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: invoiceStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Multer : gallery photos ─────────────────────────────────────────────────
const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads', 'gallery')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadGallery = multer({ storage: galleryStorage, limits: { fileSize: 15 * 1024 * 1024 } });

// ── Multer : activity photos ─────────────────────────────────────────────────
const activityPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'activities', String(req.params.id || 'tmp'));
    require('fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadActivityPhoto = multer({ storage: activityPhotoStorage, limits: { fileSize: 15 * 1024 * 1024 } });

// ── Helper ──────────────────────────────────────────────────────────────────
function createAlert(destinataireId, type, titre, contenu, sourceId = null) {
  db.prepare(`INSERT INTO alerts (destinataire_id, type, titre, contenu, source_id)
              VALUES (?, ?, ?, ?, ?)`).run(destinataireId, type, titre, contenu, sourceId);
  sseNotify([destinataireId], { type: 'alerte', alertType: type, titre, contenu });
}

// ── Endpoint SSE ──────────────────────────────────────────────────────────
app.get('/api/sse', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const uid = req.user.id;
  if (!sseClients.has(uid)) sseClients.set(uid, new Set());
  sseClients.get(uid).add(res);

  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(':ping\n\n'); } catch(_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(uid)?.delete(res);
    if (!sseClients.get(uid)?.size) sseClients.delete(uid);
  });
});

function getAdminsAndRole(role) {
  return db.prepare(`SELECT id FROM users WHERE role = ? AND actif = 1 AND (phantom IS NULL OR phantom = 0)`).all(role);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Champs requis' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND actif = 1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Email ou mot de passe invalide' });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, prenom: user.prenom, nom: user.nom, date_naissance: user.date_naissance },
    JWT_SECRET, { expiresIn: '24h' }
  );
  const { password_hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// Inscription publique → demande en attente (pending_registrations)
app.post('/api/auth/register', (req, res) => {
  const { prenom, nom, email, telephone, adresse, date_naissance, password, plan, message, source } = req.body;
  if (!prenom || !nom || !email)
    return res.status(400).json({ error: 'Champs requis manquants' });
  const effectivePassword = password || require('crypto').randomBytes(16).toString('hex');

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  if (db.prepare('SELECT id FROM pending_registrations WHERE email = ? AND statut = ?').get(email, 'en_attente'))
    return res.status(409).json({ error: 'Une demande est déjà en cours pour cet email' });

  const hash = bcrypt.hashSync(effectivePassword, 10);
  db.prepare(`INSERT INTO pending_registrations
    (prenom, nom, email, telephone, adresse, date_naissance, password_hash, plan, message, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(prenom, nom, email, telephone||'', adresse||'', date_naissance||'', hash,
         plan||'gratuit', message||'', source||'');

  // Notifier tous les exécutifs (message interne + email externe)
  const staff = db.prepare("SELECT * FROM users WHERE role IN ('admin','tresoriere','secretaire','delegue') AND actif=1").all();
  const candidat = { prenom, nom, email, telephone, plan, message };
  if (staff.length) {
    const adminId = staff[0].id;
    const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(adminId, `📋 Nouvelle demande d'adhésion — ${prenom} ${nom}`,
        `Nouvelle demande reçue.\n\nNom : ${prenom} ${nom}\nCourriel : ${email}\nTél : ${telephone||'–'}\nPlan : ${plan||'gratuit'}\nMessage : ${message||'–'}\n\nDashboard → Inscriptions pour approuver ou refuser.`);
    const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)');
    staff.forEach(s => {
      ins.run(msgR.lastInsertRowid, s.id);
      createAlert(s.id, 'inscription', `📋 Adhésion en attente : ${prenom} ${nom}`, `Plan souhaité: ${plan||'gratuit'}`);
      mailer.sendNouvelleAdhesion(s.email, candidat).catch(() => {});
    });
  }
  // Also notify extra addresses from env (e.g. president/VP personal email)
  const extraEmails = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  extraEmails.forEach(addr => mailer.sendNouvelleAdhesion(addr, candidat).catch(() => {}));
  res.status(201).json({ message: 'Demande envoyée. Vous recevrez un courriel après approbation.' });
});

// ── Gestion des inscriptions en attente (admin) ────────────────────────────
app.get('/api/inscriptions', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  res.json(db.prepare('SELECT * FROM pending_registrations ORDER BY date_soumission DESC').all());
});

app.patch('/api/inscriptions/:id/approuver', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const p = db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Demande introuvable' });
  if (p.statut !== 'en_attente') return res.status(400).json({ error: 'Demande déjà traitée' });

  // Créer le compte
  const r = db.prepare(`INSERT INTO users (prenom, nom, email, telephone, adresse, date_naissance, password_hash, role, plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?)`)
    .run(p.prenom, p.nom, p.email, p.telephone, p.adresse, p.date_naissance, p.password_hash, p.plan);

  db.prepare(`UPDATE pending_registrations SET statut='approuve', traite_par=?, date_traitement=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.user.id, p.id);

  const newUserId = r.lastInsertRowid;
  const welcomeMsg = `Bienvenue dans l'Association Haïtienne de Hamilton !\n\nBonjour ${p.prenom},\nVotre adhésion a été approuvée. Connectez-vous : http://localhost:3001/dashboard/login.html`;

  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (adminId) {
    const wMsg = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(adminId.id, 'Bienvenue dans l\'Association Haïtienne de Hamilton !', welcomeMsg);
    db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(wMsg.lastInsertRowid, newUserId);
  }
  createAlert(newUserId, 'inscription', 'Bienvenue à AHH !', 'Votre adhésion a été approuvée.');

  // Courriel de bienvenue réel
  mailer.sendBienvenue(p).catch(e => console.error('Email bienvenue:', e.message));

  // Ajouter aux salons de chat
  const generalRoom = db.prepare("SELECT id FROM chat_rooms WHERE type='general'").get();
  if (generalRoom) db.prepare('INSERT OR IGNORE INTO chat_room_members (room_id, user_id) VALUES (?,?)').run(generalRoom.id, newUserId);

  console.log(`✅ Nouveau membre approuvé: ${p.prenom} ${p.nom} (${p.email})`);
  res.json({ message: 'Membre approuvé et compte créé', userId: newUserId });
});

app.patch('/api/inscriptions/:id/refuser', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const { raison } = req.body;
  const p = db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Demande introuvable' });
  db.prepare(`UPDATE pending_registrations SET statut='refuse', traite_par=?, date_traitement=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.user.id, p.id);
  // Log le refus (l'email externe n'est pas possible en local, on le logue)
  console.log(`❌ Inscription refusée: ${p.prenom} ${p.nom} — Raison: ${raison||'–'}`);
  res.json({ message: 'Demande refusée' });
});

app.delete('/api/inscriptions/:id', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const p = db.prepare('SELECT * FROM pending_registrations WHERE id = ? AND statut != ?').get(req.params.id, 'en_attente');
  if (!p) return res.status(404).json({ error: 'Entrée introuvable ou encore en attente' });
  db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(p.id);
  res.json({ message: 'Supprimé' });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const inSubcommittee = !!db.prepare('SELECT id FROM sub_committee_members WHERE user_id = ?').get(req.user.id);
  const { password_hash, ...safe } = user;
  res.json({ ...safe, in_subcommittee: inSubcommittee });
});

// ── Calendrier membre ──────────────────────────────────────────────────────
app.get('/api/activities/my-calendar', authMiddleware, (req, res) => {
  const registered = db.prepare(`
    SELECT a.id, a.titre, a.date_debut, a.lieu, a.type, 'inscrit' AS status
    FROM activities a
    JOIN activity_registrations ar ON ar.activity_id = a.id
    WHERE ar.user_id = ? AND a.statut IN ('planifiee','en_cours','terminee')
  `).all(req.user.id);

  const registeredIds = registered.map(r => r.id);
  const placeholders = registeredIds.length ? registeredIds.map(() => '?').join(',') : '0';
  const publicActs = db.prepare(`
    SELECT id, titre, date_debut, lieu, type, 'public' AS status
    FROM activities
    WHERE statut IN ('planifiee','en_cours') AND id NOT IN (${placeholders})
    ORDER BY date_debut ASC LIMIT 30
  `).all(...registeredIds);

  res.json([...registered, ...publicActs]);
});

app.put('/api/auth/password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash))
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ message: 'Mot de passe mis à jour' });
});

// ══════════════════════════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/users', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT id, prenom, nom, email, telephone, adresse, role, actif,
    plan, plan_paid_month, plan_unpaid_count,
    date_inscription, date_naissance, bio, photo_url, email_org FROM users
    WHERE (phantom IS NULL OR phantom = 0) ORDER BY nom, prenom`).all();
  res.json(rows);
});

app.get('/api/users/:id', authMiddleware, (req, res) => {
  const u = db.prepare(`SELECT id, prenom, nom, email, telephone, adresse, role, actif,
    plan, plan_paid_month, plan_unpaid_count,
    date_inscription, date_naissance, bio, photo_url, email_org FROM users WHERE id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(u);
});

app.post('/api/users', authMiddleware, requireRole('admin'), (req, res) => {
  const { prenom, nom, email, telephone, adresse, date_naissance, role, password } = req.body;
  if (!prenom || !nom || !email || !password)
    return res.status(400).json({ error: 'Champs requis manquants' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email déjà utilisé' });
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare(`INSERT INTO users (prenom, nom, email, telephone, adresse, date_naissance, password_hash, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(prenom, nom, email, telephone||'', adresse||'', date_naissance||'', hash, role||'member');
  res.status(201).json({ id: r.lastInsertRowid });
});

const MEMBER_MGR_ROLES = ['admin','tresoriere','secretaire','delegue'];
app.put('/api/users/:id', authMiddleware, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const isMgr   = MEMBER_MGR_ROLES.includes(req.user.role);
  const isSelf  = req.user.id === parseInt(req.params.id);
  if (!isMgr && !isSelf) return res.status(403).json({ error: 'Accès refusé' });

  const { prenom, nom, email, telephone, adresse, date_naissance, role, actif, bio, operateur, sms_notifs } = req.body;
  const updates = []; const vals = [];
  if (prenom)        { updates.push('prenom = ?');        vals.push(prenom); }
  if (nom)           { updates.push('nom = ?');           vals.push(nom); }
  if (email)         { updates.push('email = ?');         vals.push(email); }
  if (telephone !== undefined) { updates.push('telephone = ?'); vals.push(telephone); }
  if (adresse !== undefined)   { updates.push('adresse = ?');   vals.push(adresse); }
  if (date_naissance !== undefined) { updates.push('date_naissance = ?'); vals.push(date_naissance); }
  if (bio !== undefined)       { updates.push('bio = ?');       vals.push(bio); }
  if (operateur !== undefined) { updates.push('operateur = ?'); vals.push(operateur || null); }
  if (sms_notifs !== undefined){ updates.push('sms_notifs = ?'); vals.push(sms_notifs ? 1 : 0); }
  if (isAdmin && role !== undefined)          { updates.push('role = ?');          vals.push(role); }
  if (isAdmin && actif !== undefined)         { updates.push('actif = ?');         vals.push(actif); }
  if (isAdmin && req.body.email_org !== undefined)    { updates.push('email_org = ?');    vals.push(req.body.email_org || null); }
  if (isAdmin && req.body.smtp_pass_org !== undefined && req.body.smtp_pass_org !== '') { updates.push('smtp_pass_org = ?'); vals.push(req.body.smtp_pass_org); }

  if (!updates.length) return res.status(400).json({ error: 'Rien à mettre à jour' });
  vals.push(req.params.id);
  db.prepare('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?').run(...vals);
  res.json({ message: 'Mis à jour' });
});

// Upload photo de profil
const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'profiles');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `user_${req.user.id}_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadProfile = multer({ storage: profileStorage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/users/:id/photo', authMiddleware, uploadProfile.single('photo'), (req, res) => {
  if (req.user.id !== parseInt(req.params.id) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Accès refusé' });
  if (!req.file) return res.status(400).json({ error: 'Photo requise' });
  const photo_url = `/uploads/profiles/${req.file.filename}`;
  db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run(photo_url, req.params.id);
  res.json({ photo_url });
});
app.use('/uploads/profiles', express.static(path.join(__dirname, 'uploads', 'profiles')));

app.delete('/api/users/:id', authMiddleware, requireRole('admin','secretaire','delegue','tresoriere'), (req, res) => {
  const uid = parseInt(req.params.id);
  if (uid === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer vous-même' });
  try {
    db.prepare('BEGIN').run();

    // Suppression des données appartenant au membre
    db.prepare('DELETE FROM message_recipients WHERE destinataire_id = ?').run(uid);
    db.prepare('DELETE FROM volunteer_hours WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM activity_registrations WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM payments WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM tax_receipts WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM talents WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM annonces WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM alerts WHERE destinataire_id = ?').run(uid);
    db.prepare('DELETE FROM recommendation_letters WHERE membre_id = ?').run(uid);
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(uid);

    // SET NULL sur les colonnes historiques (préserver les données)
    db.prepare('UPDATE messages SET expediteur_id = NULL WHERE expediteur_id = ?').run(uid);
    db.prepare('UPDATE newsletter_sends SET expediteur_id = NULL WHERE expediteur_id = ?').run(uid);
    db.prepare('UPDATE emails_externes SET expediteur_id = NULL WHERE expediteur_id = ?').run(uid);
    db.prepare('UPDATE meeting_notes SET auteur_id = NULL WHERE auteur_id = ?').run(uid);
    db.prepare('UPDATE volunteer_hours SET approuve_par = NULL WHERE approuve_par = ?').run(uid);
    db.prepare('UPDATE payments SET approuve_par = NULL WHERE approuve_par = ?').run(uid);
    db.prepare('UPDATE tax_receipts SET genere_par = NULL WHERE genere_par = ?').run(uid);
    db.prepare('UPDATE activities SET cree_par = NULL WHERE cree_par = ?').run(uid);
    db.prepare('UPDATE sub_committees SET chef_id = NULL WHERE chef_id = ?').run(uid);
    db.prepare('UPDATE projects SET responsable_id = NULL WHERE responsable_id = ?').run(uid);
    db.prepare('UPDATE recommendation_letters SET demande_par = NULL WHERE demande_par = ?').run(uid);
    db.prepare('UPDATE recommendation_letters SET genere_par = NULL WHERE genere_par = ?').run(uid);
    db.prepare('UPDATE recommendation_letters SET signe_par = NULL WHERE signe_par = ?').run(uid);
    db.prepare('UPDATE chat_messages SET sender_id = NULL WHERE sender_id = ?').run(uid);
    db.prepare('UPDATE gallery_photos SET cree_par = NULL WHERE cree_par = ?').run(uid);
    db.prepare('UPDATE transactions SET cree_par = NULL WHERE cree_par = ?').run(uid);
    db.prepare('UPDATE invoices SET cree_par = NULL WHERE cree_par = ?').run(uid);
    db.prepare('UPDATE activity_tables SET membre_attribue = NULL WHERE membre_attribue = ?').run(uid);
    db.prepare('UPDATE tickets SET user_id = NULL WHERE user_id = ?').run(uid);
    db.prepare('UPDATE tickets SET vendu_par = NULL WHERE vendu_par = ?').run(uid);
    db.prepare('UPDATE pending_registrations SET traite_par = NULL WHERE traite_par = ?').run(uid);

    // Retirer le membre des salons de chat et sous-comités
    db.prepare('DELETE FROM chat_room_members WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM sub_committee_members WHERE user_id = ?').run(uid);

    // Supprimer le membre
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);

    db.prepare('COMMIT').run();
    res.json({ message: 'Membre supprimé' });
  } catch(e) {
    try { db.prepare('ROLLBACK').run(); } catch {}
    console.error('Erreur suppression membre:', e.message);
    res.status(500).json({ error: 'Erreur lors de la suppression : ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVITIES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/activities', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.prenom || ' ' || u.nom AS createur,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = a.id) +
    (SELECT COUNT(*) FROM tickets WHERE activity_id = a.id AND payment_status = 'paid') AS nb_inscrits,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = a.id AND user_id = ?) AS user_registered
    FROM activities a LEFT JOIN users u ON u.id = a.cree_par ORDER BY a.date_debut DESC
  `).all(req.user.id);
  res.json(rows);
});

const ACTIVITY_ROLES = ['admin','tresoriere','secretaire','delegue'];
const DISCOUNT_ROLES  = ['admin']; // VP = admin role, Présidente = admin role

const crypto2 = require('crypto');
const QRCode  = require('qrcode');
const jimp    = require('jimp');
const bwipjs  = require('bwip-js');

// Génère un code-barres Code128 PNG en buffer
async function generateBarcode(data, opts = {}) {
  return bwipjs.toBuffer({
    bcid: 'code128', text: data, scale: 3, height: 14,
    includetext: true, textxalign: 'center', textsize: 9,
    backgroundcolor: 'ffffff', ...opts
  });
}

// Génère un code court unique pour barcode (ex: AHH-A3X9K2)
function newBarcodeData() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'AHH-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/activities', authMiddleware, requireRole(...ACTIVITY_ROLES), (req, res) => {
  const { titre, description, type, date_debut, date_fin, lieu, budget_prevu, max_participants,
          prix, paiement_requis, rabais_json } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });

  const qr_token = crypto2.randomBytes(16).toString('hex');
  const r = db.prepare(`INSERT INTO activities
    (titre, description, type, date_debut, date_fin, lieu, budget_prevu, max_participants, cree_par,
     prix, paiement_requis, rabais_json, qr_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(titre, description||'', type||'general', date_debut||'', date_fin||'', lieu||'',
         budget_prevu||0, max_participants||null, req.user.id,
         parseFloat(prix)||0, paiement_requis?1:0,
         rabais_json||'{}', qr_token);
  // Créer ligne financière immédiatement si budget prévu
  if (budget_prevu && parseFloat(budget_prevu) > 0) {
    db.prepare(`INSERT OR IGNORE INTO financial_lines (activity_id, titre, budget_alloue) VALUES (?, ?, ?)`)
      .run(r.lastInsertRowid, `Budget – ${titre}`, parseFloat(budget_prevu));
  }
  res.status(201).json({ id: r.lastInsertRowid, qr_token });
});

app.put('/api/activities/:id', authMiddleware, requireRole(...ACTIVITY_ROLES), (req, res) => {
  const { titre, description, type, date_debut, date_fin, lieu, budget_prevu, max_participants, statut,
          prix, paiement_requis, rabais_json } = req.body;
  const prev = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Activité introuvable' });

  // Lancer l'activité → créer une ligne financière + alertes
  if (statut === 'en_cours' && prev.statut === 'planifiee') {
    const fl = db.prepare(`INSERT INTO financial_lines (activity_id, titre, budget_alloue)
      VALUES (?, ?, ?)`).run(prev.id, `Budget – ${prev.titre}`, prev.budget_prevu || 0);

    // Alerter la trésorière
    getAdminsAndRole('tresoriere').forEach(t =>
      createAlert(t.id, 'activite', `Activité lancée : ${prev.titre}`,
        `Une ligne financière a été créée. Budget alloué : $${prev.budget_prevu || 0}`, fl.lastInsertRowid));
    // Alerter les admins
    getAdminsAndRole('admin').forEach(a =>
      createAlert(a.id, 'activite', `Activité lancée : ${prev.titre}`, `Statut passé à "En cours".`, prev.id));

    // SMS à tous les membres actifs ayant un opérateur configuré
    const dateStr = prev.date_debut ? new Date(prev.date_debut).toLocaleDateString('fr-CA') : '';
    const smsText = `Nouvelle activité AHH : "${prev.titre}"${dateStr ? ' le ' + dateStr : ''}${prev.lieu ? ' à ' + prev.lieu : ''}. Connectez-vous pour vous inscrire.`;
    const membresAvecSMS = db.prepare("SELECT telephone, operateur, sms_notifs FROM users WHERE actif=1 AND operateur IS NOT NULL AND sms_notifs=1").all();
    membresAvecSMS.forEach(m => mailer.sendSMS(m, smsText).catch(() => {}));
  }

  db.prepare(`UPDATE activities SET titre=?, description=?, type=?, date_debut=?, date_fin=?, lieu=?,
    budget_prevu=?, max_participants=?, statut=?, prix=?, paiement_requis=?, rabais_json=? WHERE id=?`)
    .run(titre||prev.titre, description??prev.description, type||prev.type, date_debut||prev.date_debut,
         date_fin||prev.date_fin, lieu||prev.lieu, budget_prevu??prev.budget_prevu,
         max_participants??prev.max_participants, statut||prev.statut,
         prix!==undefined ? parseFloat(prix)||0 : prev.prix||0,
         paiement_requis!==undefined ? (paiement_requis?1:0) : prev.paiement_requis||0,
         rabais_json||prev.rabais_json||'{}',
         req.params.id);
  res.json({ message: 'Activité mise à jour' });
});

app.delete('/api/activities/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const actId = parseInt(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  try {
    // Disable FK checks for the duration of this cascaded delete
    db.exec('PRAGMA foreign_keys = OFF');

    // Clean up all financial lines linked to this activity
    const lines = db.prepare('SELECT * FROM financial_lines WHERE activity_id = ?').all(actId);
    lines.forEach(line => {
      const txRows = db.prepare('SELECT * FROM transactions WHERE financial_line_id = ?').all(line.id);
      txRows.forEach(t => {
        if (t.type === 'depense')
          db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(t.montant);
        else if (t.type === 'revenu')
          db.prepare('UPDATE account_info SET solde = solde - ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(t.montant);
      });
      db.prepare('DELETE FROM transactions WHERE financial_line_id = ?').run(line.id);
      db.prepare('DELETE FROM invoices WHERE financial_line_id = ?').run(line.id);
      db.prepare('DELETE FROM financial_lines WHERE id = ?').run(line.id);
    });

    db.prepare('DELETE FROM activity_registrations WHERE activity_id = ?').run(actId);
    db.prepare('DELETE FROM activity_photos WHERE activity_id = ?').run(actId);
    db.prepare('DELETE FROM activities WHERE id = ?').run(actId);

    res.json({ message: 'Activité supprimée' });
  } catch (err) {
    console.error('Delete activity error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
});

app.patch('/api/activities/:id/archive', authMiddleware, requireRole('admin','secretaire','tresoriere'), (req, res) => {
  db.prepare("UPDATE activities SET statut = 'archivee' WHERE id = ?").run(req.params.id);
  res.json({ message: 'Activité archivée' });
});

app.patch('/api/activities/:id/unarchive', authMiddleware, requireRole('admin','secretaire','tresoriere'), (req, res) => {
  db.prepare("UPDATE activities SET statut = 'terminee' WHERE id = ?").run(req.params.id);
  res.json({ message: 'Activité restaurée' });
});

app.post('/api/activities/:id/register', authMiddleware, (req, res) => {
  try {
    db.prepare('INSERT INTO activity_registrations (activity_id, user_id) VALUES (?, ?)')
      .run(req.params.id, req.user.id);
    const activite = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
    if (activite) mailer.sendInscriptionActivite(req.user, activite).catch(()=>{});
    res.status(201).json({ message: 'Inscription confirmée' });
  } catch {
    res.status(409).json({ error: 'Déjà inscrit' });
  }
});

app.delete('/api/activities/:id/register', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM activity_registrations WHERE activity_id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  res.json({ message: 'Inscription annulée' });
});

app.get('/api/activities/:id/registrations', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.prenom, u.nom, u.email, u.telephone, ar.statut, ar.date_inscription
    FROM activity_registrations ar JOIN users u ON u.id = ar.user_id WHERE ar.activity_id = ?`).all(req.params.id);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// FINANCE
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/finance/lines', authMiddleware, requireRole('admin', 'tresoriere'), (req, res) => {
  const rows = db.prepare(`
    SELECT fl.*, a.titre AS activite, p.nom AS projet,
      COALESCE((SELECT SUM(t.montant) FROM transactions t WHERE t.financial_line_id = fl.id AND t.type = 'depense'), 0) AS depenses,
      COALESCE((SELECT SUM(t.montant) FROM transactions t WHERE t.financial_line_id = fl.id AND t.type = 'revenu'), 0) AS revenus,
      COALESCE((SELECT SUM(i.montant) FROM invoices i WHERE i.financial_line_id = fl.id AND i.statut = 'en_attente'), 0) AS depenses_en_attente,
      COALESCE(fl.commanditaires, 0) AS commanditaires
    FROM financial_lines fl
    LEFT JOIN activities a ON a.id = fl.activity_id
    LEFT JOIN projects p ON p.id = fl.project_id
    ORDER BY fl.date_creation DESC
  `).all();
  res.json(rows);
});

app.get('/api/finance/summary', authMiddleware, requireRole('admin', 'tresoriere'), (req, res) => {
  const account = db.prepare('SELECT * FROM account_info WHERE id = 1').get() || {};
  const actCount = db.prepare("SELECT COUNT(*) AS cnt FROM activities WHERE statut IN ('planifiee','en_cours')").get().cnt;
  const projCount = db.prepare("SELECT COUNT(*) AS cnt FROM projects WHERE statut IN ('en_cours','planifie')").get().cnt;
  res.json({ solde: account.solde || 0, projets_en_cours: actCount + projCount });
});

app.get('/api/finance/transactions', authMiddleware, requireRole('admin', 'tresoriere'), (req, res) => {
  const { line_id } = req.query;
  const q = line_id
    ? 'WHERE t.financial_line_id = ?'
    : '';
  const rows = db.prepare(`
    SELECT t.*, u.prenom || ' ' || u.nom AS createur, fl.titre AS ligne
    FROM transactions t
    LEFT JOIN users u ON u.id = t.cree_par
    LEFT JOIN financial_lines fl ON fl.id = t.financial_line_id
    ${q} ORDER BY t.date_transaction DESC
  `).all(...(line_id ? [line_id] : []));
  res.json(rows);
});

app.post('/api/finance/transactions', authMiddleware, requireRole('tresoriere', 'admin'), (req, res) => {
  const { financial_line_id, type, montant, description, methode, reference, invoice_id } = req.body;
  if (!type || !montant) return res.status(400).json({ error: 'Type et montant requis' });

  const r = db.prepare(`INSERT INTO transactions (financial_line_id, type, montant, description, methode, reference, invoice_id, cree_par)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(financial_line_id||null, type, montant, description||'', methode||'cash', reference||'', invoice_id||null, req.user.id);

  if (type === 'depense') {
    // Update account balance
    db.prepare('UPDATE account_info SET solde = solde - ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(montant);
    // Alert admins
    getAdminsAndRole('admin').forEach(a =>
      createAlert(a.id, 'depense', `Dépense enregistrée : $${montant}`, description || '', r.lastInsertRowid));
  } else if (type === 'revenu') {
    db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(montant);
  }
  res.status(201).json({ id: r.lastInsertRowid });
});

app.get('/api/finance/account', authMiddleware, requireRole('admin', 'tresoriere'), (req, res) => {
  const info = db.prepare('SELECT * FROM account_info WHERE id = 1').get();
  res.json(info || {});
});

app.put('/api/finance/account', authMiddleware, requireRole('tresoriere', 'admin'), (req, res) => {
  const { institution, numero_compte, nom_titulaire, solde } = req.body;
  db.prepare(`UPDATE account_info SET institution=?, numero_compte=?, nom_titulaire=?, solde=?, date_maj=CURRENT_TIMESTAMP WHERE id=1`)
    .run(institution||'', numero_compte||'', nom_titulaire||'', solde||0);
  res.json({ message: 'Compte mis à jour' });
});

// Invoices
app.get('/api/finance/invoices', authMiddleware, requireRole('admin', 'tresoriere'), (req, res) => {
  const rows = db.prepare(`SELECT i.*, u.prenom || ' ' || u.nom AS createur, fl.titre AS ligne
    FROM invoices i LEFT JOIN users u ON u.id = i.cree_par LEFT JOIN financial_lines fl ON fl.id = i.financial_line_id
    ORDER BY i.date_upload DESC`).all();
  res.json(rows);
});

app.post('/api/finance/invoices', authMiddleware, requireRole('tresoriere', 'admin'), upload.single('photo'), (req, res) => {
  const { titre, fournisseur, montant, date_facture, financial_line_id } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const photo_path = req.file ? `/uploads/invoices/${req.file.filename}` : null;
  const r = db.prepare(`INSERT INTO invoices (titre, fournisseur, montant, date_facture, photo_path, financial_line_id, cree_par)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(titre, fournisseur||'', montant||0, date_facture||'', photo_path, financial_line_id||null, req.user.id);

  // Alert admins
  getAdminsAndRole('admin').forEach(a =>
    createAlert(a.id, 'depense', `Nouvelle facture : ${titre}`, `Fournisseur: ${fournisseur||'-'} | Montant: $${montant||0}`, r.lastInsertRowid));
  res.status(201).json({ id: r.lastInsertRowid, photo_path });
});

app.put('/api/finance/invoices/:id', authMiddleware, requireRole('tresoriere', 'admin'), (req, res) => {
  const { statut } = req.body;
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
  db.prepare('UPDATE invoices SET statut = ? WHERE id = ?').run(statut, req.params.id);
  // Dès qu'une facture est approuvée → enregistrer la dépense dans la ligne financière
  const wasAlreadyApprovedOrPaid = ['approuve','paye'].includes(invoice.statut);
  if (statut === 'approuve' && !wasAlreadyApprovedOrPaid && invoice.financial_line_id) {
    db.prepare(`INSERT INTO transactions (financial_line_id, type, montant, description, methode, invoice_id, cree_par)
      VALUES (?, 'depense', ?, ?, 'facture', ?, ?)`)
      .run(invoice.financial_line_id, invoice.montant, `Facture approuvée: ${invoice.titre}`, invoice.id, req.user.id);
    db.prepare('UPDATE account_info SET solde = solde - ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(invoice.montant);
  }
  res.json({ message: 'Mise à jour' });
});

// Supprimer une facture (annule l'effet sur la ligne financière)
app.delete('/api/finance/invoices/:id', authMiddleware, requireRole('tresoriere', 'admin'), (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
  // Si facture approuvée, inverser la transaction associée
  if (invoice.statut === 'approuve' && invoice.financial_line_id) {
    db.prepare('DELETE FROM transactions WHERE invoice_id = ?').run(invoice.id);
    db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(invoice.montant);
  }
  // Supprimer le fichier photo si présent
  if (invoice.photo_path) {
    try { require('fs').unlinkSync(require('path').join(__dirname, invoice.photo_path)); } catch {}
  }
  db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/messages', authMiddleware, (req, res) => {
  const trash = req.query.trash === '1';
  const inbox = db.prepare(`
    SELECT m.*, u.prenom || ' ' || u.nom AS expediteur, mr.lu, mr.date_lecture, mr.supprime
    FROM message_recipients mr
    JOIN messages m ON m.id = mr.message_id
    JOIN users u ON u.id = m.expediteur_id
    WHERE mr.destinataire_id = ? AND mr.supprime = ?
    ORDER BY m.date_envoi DESC
  `).all(req.user.id, trash ? 1 : 0);

  const sent = db.prepare(`
    SELECT m.*, COUNT(mr.id) AS nb_destinataires
    FROM messages m
    LEFT JOIN message_recipients mr ON mr.message_id = m.id
    WHERE m.expediteur_id = ? AND m.supprime_sent = ?
    GROUP BY m.id ORDER BY m.date_envoi DESC
  `).all(req.user.id, trash ? 1 : 0);

  res.json({ inbox, sent });
});

// Supprimer (mettre en corbeille)
app.delete('/api/messages/:id', authMiddleware, (req, res) => {
  const id   = req.params.id;
  const type = req.query.type || 'inbox'; // inbox | sent

  if (type === 'sent') {
    db.prepare('UPDATE messages SET supprime_sent = 1 WHERE id = ? AND expediteur_id = ?')
      .run(id, req.user.id);
  } else {
    db.prepare('UPDATE message_recipients SET supprime = 1 WHERE message_id = ? AND destinataire_id = ?')
      .run(id, req.user.id);
  }
  res.json({ message: 'Déplacé à la corbeille' });
});

// Restaurer depuis la corbeille
app.put('/api/messages/:id/restore', authMiddleware, (req, res) => {
  const id   = req.params.id;
  const type = req.query.type || 'inbox';
  if (type === 'sent') {
    db.prepare('UPDATE messages SET supprime_sent = 0 WHERE id = ? AND expediteur_id = ?').run(id, req.user.id);
  } else {
    db.prepare('UPDATE message_recipients SET supprime = 0 WHERE message_id = ? AND destinataire_id = ?').run(id, req.user.id);
  }
  res.json({ message: 'Restauré' });
});

// Supprimer définitivement
app.delete('/api/messages/:id/permanent', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM message_recipients WHERE message_id = ? AND destinataire_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Supprimé définitivement' });
});

app.post('/api/messages', authMiddleware, (req, res) => {
  const { sujet, contenu, destinataires } = req.body;
  if (!contenu || !destinataires?.length) return res.status(400).json({ error: 'Contenu et destinataires requis' });

  let targets = [];
  if (destinataires[0] === 'all') {
    targets = db.prepare('SELECT id FROM users WHERE actif = 1 AND id != ? AND (phantom IS NULL OR phantom = 0)').all(req.user.id).map(u => u.id);
  } else if (destinataires[0] === 'members') {
    targets = db.prepare("SELECT id FROM users WHERE role = 'member' AND actif = 1").all().map(u => u.id);
  } else {
    targets = destinataires;
  }

  const r = db.prepare('INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?, ?, ?, ?)')
    .run(req.user.id, sujet||'', contenu, targets.length > 1 ? 'rafale' : 'individuel');

  const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?, ?)');
  targets.forEach(id => ins.run(r.lastInsertRowid, id));

  // Notifier les destinataires en temps réel
  const expedNom = (() => { const u = db.prepare('SELECT prenom,nom FROM users WHERE id=?').get(req.user.id); return u ? `${u.prenom} ${u.nom}` : 'AHH'; })();
  sseNotify(targets, { type: 'message', titre: `✉️ Nouveau message de ${expedNom}`, contenu: sujet || contenu.substring(0, 60) });

  // SMS aux destinataires (envoi silencieux)
  const expediteur = db.prepare('SELECT prenom, nom FROM users WHERE id = ?').get(req.user.id);
  const expediteurNom = expediteur ? `${expediteur.prenom} ${expediteur.nom}` : 'AHH';
  targets.forEach(uid => {
    const dest = db.prepare('SELECT telephone, operateur, sms_notifs FROM users WHERE id = ?').get(uid);
    if (dest?.sms_notifs && dest?.operateur) {
      const preview = (sujet || '').substring(0, 40) || contenu.substring(0, 40);
      mailer.sendSMS(dest, `Nouveau message de ${expediteurNom}: ${preview}`).catch(() => {});
    }
  });

  res.status(201).json({ id: r.lastInsertRowid, nb_destinataires: targets.length });
});

app.put('/api/messages/:id/read', authMiddleware, (req, res) => {
  db.prepare(`UPDATE message_recipients SET lu = 1, date_lecture = CURRENT_TIMESTAMP
    WHERE message_id = ? AND destinataire_id = ?`).run(req.params.id, req.user.id);
  res.json({ message: 'Lu' });
});

app.get('/api/messages/unread-count', authMiddleware, (req, res) => {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM message_recipients
    WHERE destinataire_id = ? AND lu = 0`).get(req.user.id);
  res.json({ count });
});

// ══════════════════════════════════════════════════════════════════════════════
// VOLUNTEER HOURS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/volunteer', authMiddleware, (req, res) => {
  const isAdmin = ['admin', 'secretaire'].includes(req.user.role);
  const query = isAdmin
    ? `SELECT vh.*, u.prenom || ' ' || u.nom AS membre, a.titre AS activite,
         ap.prenom || ' ' || ap.nom AS approuveur
       FROM volunteer_hours vh LEFT JOIN users u ON u.id = vh.user_id
       LEFT JOIN activities a ON a.id = vh.activity_id
       LEFT JOIN users ap ON ap.id = vh.approuve_par ORDER BY vh.date_service DESC`
    : `SELECT vh.*, a.titre AS activite FROM volunteer_hours vh
       LEFT JOIN activities a ON a.id = vh.activity_id WHERE vh.user_id = ? ORDER BY vh.date_service DESC`;
  const rows = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
  res.json(rows);
});

app.post('/api/volunteer', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const { user_id, activity_id, heures, description, date_service } = req.body;
  if (!user_id || !heures) return res.status(400).json({ error: 'Membre et heures requis' });
  const r = db.prepare(`INSERT INTO volunteer_hours (user_id, activity_id, heures, description, date_service)
    VALUES (?, ?, ?, ?, ?)`).run(user_id, activity_id||null, heures, description||'', date_service||'');
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/volunteer/:id/approve', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const { statut } = req.body;
  const vh = db.prepare('SELECT * FROM volunteer_hours WHERE id = ?').get(req.params.id);
  db.prepare(`UPDATE volunteer_hours SET statut = ?, approuve_par = ?, date_approbation = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(statut, req.user.id, req.params.id);
  // Email au membre si heures approuvées
  if (statut === 'approuve' && vh) {
    const membre = db.prepare('SELECT * FROM users WHERE id = ?').get(vh.user_id);
    if (membre) {
      mailer.sendHeuresBenevolat(membre, vh.heures, vh.description, vh.date_service).catch(() => {});
      createAlert(membre.id, 'benevolat', `✅ ${vh.heures}h de bénévolat approuvées`, vh.description || '');
    }
  }
  res.json({ message: 'Statut mis à jour' });
});

app.delete('/api/volunteer/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM volunteer_hours WHERE id = ?').run(req.params.id);
  res.json({ message: 'Supprimé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// MEETING NOTES
// ══════════════════════════════════════════════════════════════════════════════

// Notes — toutes visibles au comité (style Google Docs partagé)
app.get('/api/notes', authMiddleware, (req, res) => {
  const COMITE = ['admin','tresoriere','secretaire','delegue'];
  const rows = db.prepare(`
    SELECT n.*,
      u.prenom || ' ' || u.nom AS auteur,
      a.titre AS activite,
      le.prenom || ' ' || le.nom AS last_editor_nom,
      eb.prenom || ' ' || eb.nom AS editing_by_nom
    FROM meeting_notes n
    LEFT JOIN users u  ON u.id  = n.auteur_id
    LEFT JOIN users le ON le.id = n.last_editor_id
    LEFT JOIN users eb ON eb.id = n.editing_by
    LEFT JOIN activities a ON a.id = n.activity_id
    WHERE (n.auteur_id = ? OR ? IN ('admin','secretaire','tresoriere','delegue'))
    ORDER BY COALESCE(n.date_modification, n.date_reunion) DESC
  `).all(req.user.id, req.user.role);
  // Nettoyer les sessions d'édition inactives (>5 min)
  db.prepare("UPDATE meeting_notes SET editing_by=NULL, editing_since=NULL WHERE editing_since < datetime('now','-5 minutes')").run();
  res.json(rows);
});

app.post('/api/notes', authMiddleware, (req, res) => {
  const { titre, contenu, langue, date_reunion, activity_id } = req.body;
  const r = db.prepare(`INSERT INTO meeting_notes (auteur_id, titre, contenu, langue, date_reunion, activity_id, last_editor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, titre||'Sans titre', contenu||'', langue||'fr', date_reunion||'', activity_id||null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/notes/:id', authMiddleware, (req, res) => {
  const { titre, contenu, contenu_corrige, langue, date_reunion, activity_id } = req.body;
  db.prepare(`UPDATE meeting_notes SET titre=?, contenu=?, contenu_corrige=?, langue=?,
    date_reunion=COALESCE(?,date_reunion), activity_id=?,
    date_modification=CURRENT_TIMESTAMP, last_editor_id=?, editing_by=NULL, editing_since=NULL
    WHERE id=?`)
    .run(titre||'', contenu||'', contenu_corrige||null, langue||'fr',
      date_reunion||null, activity_id||null, req.user.id, req.params.id);
  res.json({ ok: true });
});

// Marquer "en train d'éditer"
app.post('/api/notes/:id/editing', authMiddleware, (req, res) => {
  db.prepare("UPDATE meeting_notes SET editing_by=?, editing_since=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id, req.params.id);
  res.json({ ok: true });
});

// Libérer la session d'édition
app.delete('/api/notes/:id/editing', authMiddleware, (req, res) => {
  db.prepare("UPDATE meeting_notes SET editing_by=NULL, editing_since=NULL WHERE id=? AND editing_by=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Lire une note spécifique (pour sync en temps réel)
app.get('/api/notes/:id', authMiddleware, (req, res) => {
  const n = db.prepare(`SELECT n.*, le.prenom AS le_prenom, le.nom AS le_nom, eb.prenom AS eb_prenom, eb.nom AS eb_nom
    FROM meeting_notes n
    LEFT JOIN users le ON le.id = n.last_editor_id
    LEFT JOIN users eb ON eb.id = n.editing_by
    WHERE n.id=?`).get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Introuvable' });
  res.json(n);
});

app.delete('/api/notes/:id', authMiddleware, (req, res) => {
  const note = db.prepare('SELECT * FROM meeting_notes WHERE id = ?').get(req.params.id);
  if (note.auteur_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM meeting_notes WHERE id = ?').run(req.params.id);
  res.json({ message: 'Supprimée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// AI – SPELL CHECK + RECOMMENDATION LETTERS
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/ai/spellcheck', authMiddleware, async (req, res) => {
  const { texte, langue } = req.body;
  if (!texte) return res.status(400).json({ error: 'Texte requis' });

  if (!process.env.ANTHROPIC_API_KEY)
    return res.json({ corrige: texte, note: 'API key non configurée – texte inchangé' });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.Anthropic();
    const langNames = { fr: 'français', en: 'anglais', ht: 'créole haïtien' };
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Corrige l'orthographe, la grammaire et la ponctuation du texte suivant en ${langNames[langue]||'français'}.
Retourne UNIQUEMENT le texte corrigé, sans explication ni commentaire.\n\nTexte:\n${texte}`
      }]
    });
    res.json({ corrige: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: 'Erreur API: ' + e.message });
  }
});

app.post('/api/ai/recommendation', authMiddleware, requireRole('admin', 'secretaire'), async (req, res) => {
  const { membre_id, langue, raison } = req.body;
  if (!membre_id) return res.status(400).json({ error: 'Membre requis' });

  const membre = db.prepare('SELECT * FROM users WHERE id = ?').get(membre_id);
  if (!membre) return res.status(404).json({ error: 'Membre introuvable' });

  const heures = db.prepare(`SELECT COALESCE(SUM(heures), 0) AS total FROM volunteer_hours
    WHERE user_id = ? AND statut = 'approuve'`).get(membre_id);
  const activites = db.prepare(`SELECT COUNT(*) AS total FROM activity_registrations WHERE user_id = ?`).get(membre_id);

  const org = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  let contenu;
  if (!process.env.ANTHROPIC_API_KEY) {
    const langLabel = langue === 'en' ? 'English' : 'français';
    contenu = `[LETTRE DE RECOMMANDATION – ${langLabel.toUpperCase()}]\n\nÀ qui de droit,\n\nNous recommandons ${membre.prenom} ${membre.nom}, membre actif de l'Association Haïtienne de Hamilton (AHH).\n\nDurant son engagement, ${membre.prenom} a accumulé ${heures.total} heures de bénévolat et participé à ${activites.total} activités communautaires.\n\n${raison || ''}\n\nCordialement,\n${org.prenom} ${org.nom}\n${org.role.charAt(0).toUpperCase() + org.role.slice(1)}, AHH`;
  } else {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.Anthropic();
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Rédige une lettre de recommandation professionnelle en ${langue === 'en' ? 'anglais' : 'français'} pour:
- Nom: ${membre.prenom} ${membre.nom}
- Organisation: Association Haïtienne de Hamilton (AHH)
- Heures de bénévolat approuvées: ${heures.total}h
- Activités participées: ${activites.total}
- Contexte/raison: ${raison || 'Engagement communautaire général'}
- Signataire: ${org.prenom} ${org.nom}, ${org.role}

La lettre doit être formelle, chaleureuse et mettre en valeur les contributions du membre.`
        }]
      });
      contenu = response.content[0].text;
    } catch (e) {
      return res.status(500).json({ error: 'Erreur API: ' + e.message });
    }
  }

  const r = db.prepare(`INSERT INTO recommendation_letters (membre_id, demande_par, genere_par, contenu, date_generation, statut)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'genere')`).run(membre_id, membre_id, req.user.id, contenu);

  res.json({ id: r.lastInsertRowid, contenu, membre: `${membre.prenom} ${membre.nom}` });
});

app.get('/api/ai/recommendations', authMiddleware, (req, res) => {
  const isAdmin = ['admin', 'secretaire'].includes(req.user.role);
  const q = isAdmin
    ? `SELECT rl.*, u.prenom || ' ' || u.nom AS membre_nom FROM recommendation_letters rl JOIN users u ON u.id = rl.membre_id ORDER BY rl.date_demande DESC`
    : `SELECT rl.*, u.prenom || ' ' || u.nom AS membre_nom FROM recommendation_letters rl JOIN users u ON u.id = rl.membre_id WHERE rl.membre_id = ? ORDER BY rl.date_demande DESC`;
  const rows = isAdmin ? db.prepare(q).all() : db.prepare(q).all(req.user.id);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUB-COMMITTEES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/subcommittees', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT sc.*, u.prenom || ' ' || u.nom AS chef_nom, a.titre AS activite_titre
    FROM sub_committees sc LEFT JOIN users u ON u.id = sc.chef_id LEFT JOIN activities a ON a.id = sc.activity_id
    ORDER BY sc.date_creation DESC`).all();
  rows.forEach(sc => {
    sc.membres = db.prepare(`SELECT u.id, u.prenom, u.nom, u.role, scm.role_comite
      FROM sub_committee_members scm JOIN users u ON u.id = scm.user_id WHERE scm.committee_id = ?`).all(sc.id);
  });
  res.json(rows);
});

app.post('/api/subcommittees', authMiddleware, requireRole('admin'), (req, res) => {
  const { nom, description, activity_id, chef_id, membres } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare('INSERT INTO sub_committees (nom, description, activity_id, chef_id) VALUES (?, ?, ?, ?)')
    .run(nom, description||'', activity_id||null, chef_id||null);
  if (membres?.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO sub_committee_members (committee_id, user_id, role_comite) VALUES (?, ?, ?)');
    membres.forEach(m => ins.run(r.lastInsertRowid, m.user_id, m.role||'membre'));
  }
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/subcommittees/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const { nom, description, statut, chef_id, activity_id, membres } = req.body;
  db.prepare('UPDATE sub_committees SET nom=?, description=?, statut=?, chef_id=?, activity_id=? WHERE id=?')
    .run(nom||'', description||'', statut||'actif', chef_id||null, activity_id||null, req.params.id);
  if (membres !== undefined) {
    db.prepare('DELETE FROM sub_committee_members WHERE committee_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO sub_committee_members (committee_id, user_id, role_comite) VALUES (?, ?, ?)');
    membres.forEach(m => ins.run(req.params.id, m.user_id, m.role||'membre'));
  }
  res.json({ message: 'Mis à jour' });
});

app.delete('/api/subcommittees/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM sub_committees WHERE id = ?').run(req.params.id);
  res.json({ message: 'Sous-comité supprimé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/alerts', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT * FROM alerts WHERE destinataire_id = ? ORDER BY date_creation DESC LIMIT 50`)
    .all(req.user.id);
  res.json(rows);
});

app.put('/api/alerts/:id/read', authMiddleware, (req, res) => {
  db.prepare('UPDATE alerts SET lu = 1 WHERE id = ? AND destinataire_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Lu' });
});

app.put('/api/alerts/read-all', authMiddleware, (req, res) => {
  db.prepare('UPDATE alerts SET lu = 1 WHERE destinataire_id = ?').run(req.user.id);
  res.json({ message: 'Toutes lues' });
});

// ══════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/projects', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT p.*, u.prenom || ' ' || u.nom AS responsable_nom
    FROM projects p LEFT JOIN users u ON u.id = p.responsable_id ORDER BY p.date_creation DESC`).all();
  res.json(rows);
});

app.post('/api/projects', authMiddleware, requireRole('admin'), (req, res) => {
  const { nom, description, responsable_id, date_debut, date_fin, budget_prevu, notes } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare(`INSERT INTO projects (nom, description, responsable_id, date_debut, date_fin, budget_prevu, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(nom, description||'', responsable_id||null, date_debut||'', date_fin||'', parseFloat(budget_prevu)||0, notes||'');
  // Créer ligne financière pour le projet
  db.prepare(`INSERT INTO financial_lines (project_id, titre, budget_alloue) VALUES (?, ?, ?)`)
    .run(r.lastInsertRowid, `Budget – ${nom}`, parseFloat(budget_prevu)||0);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/projects/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const { nom, description, statut, progression, date_debut, date_fin, budget_prevu, notes } = req.body;
  const prev = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Projet introuvable' });
  db.prepare(`UPDATE projects SET nom=?, description=?, statut=?, progression=?, date_debut=?, date_fin=?, budget_prevu=?, notes=? WHERE id=?`)
    .run(nom||prev.nom, description??prev.description, statut||prev.statut, progression??prev.progression,
         date_debut||prev.date_debut, date_fin||prev.date_fin, parseFloat(budget_prevu)||prev.budget_prevu||0, (notes!=null?notes:prev.notes)||'', req.params.id);
  // Mettre à jour la ligne financière si budget changé
  if (budget_prevu !== undefined) {
    db.prepare(`UPDATE financial_lines SET budget_alloue=? WHERE project_id=?`)
      .run(parseFloat(budget_prevu)||0, req.params.id);
  }
  res.json({ message: 'Mis à jour' });
});

app.delete('/api/projects/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const prev = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Projet introuvable' });
  try {
    const lineIds = db.prepare('SELECT id FROM financial_lines WHERE project_id = ?').all(req.params.id).map(l => l.id);
    if (lineIds.length) {
      const placeholders = lineIds.map(() => '?').join(',');
      db.prepare('DELETE FROM transactions WHERE financial_line_id IN (' + placeholders + ')').run(...lineIds);
      db.prepare('DELETE FROM invoices WHERE financial_line_id IN (' + placeholders + ')').run(...lineIds);
      db.prepare('DELETE FROM financial_lines WHERE project_id = ?').run(req.params.id);
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ message: 'Projet supprimé' });
  } catch(e) {
    console.error('deleteProject:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// COURRIEL EXTERNE
// ══════════════════════════════════════════════════════════════════════════════

const COMITE_ROLES = ['admin','tresoriere','secretaire','delegue'];

app.post('/api/email/send', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Champs manquants' });
  const sender = db.prepare('SELECT prenom, nom, email, email_org, smtp_pass_org FROM users WHERE id = ?').get(req.user.id);
  const senderName  = sender ? sender.prenom + ' ' + sender.nom : 'Comité AHH';
  const senderEmail = sender?.email || '';
  // Utiliser email_org si défini, sinon l'email principal s'il est @ahhamilton.ca
  const orgEmail    = sender?.email_org || (senderEmail.endsWith('@ahhamilton.ca') ? senderEmail : null);
  const orgSmtpPass = sender?.smtp_pass_org || null;
  const bodyHtml = body.replace(/\n/g, '<br/>');
  try {
    await mailer.sendExternalEmail({ to, subject, bodyHtml, senderName, senderEmail, orgEmail, orgSmtpPass });
    db.prepare(`INSERT INTO emails_externes (expediteur_id, expediteur_nom, expediteur_email, destinataire, sujet, corps, statut)
      VALUES (?, ?, ?, ?, ?, ?, 'envoye')`)
      .run(req.user.id, senderName, senderEmail, to, subject, body);
    res.json({ message: 'Courriel envoyé' });
  } catch(e) {
    db.prepare(`INSERT INTO emails_externes (expediteur_id, expediteur_nom, expediteur_email, destinataire, sujet, corps, statut)
      VALUES (?, ?, ?, ?, ?, ?, 'erreur')`)
      .run(req.user.id, senderName, senderEmail, to, subject, body);
    res.status(500).json({ error: 'Échec d\'envoi: ' + e.message });
  }
});

app.get('/api/email/sent', authMiddleware, requireRole(...COMITE_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT * FROM emails_externes ORDER BY date_envoi DESC LIMIT 100`).all();
  res.json(rows);
});

// ── Helper : courriel IMAP selon l'utilisateur ────────────────────────────
// Utilise email_org de l'utilisateur s'il se termine par @ahhamilton.ca,
// sinon utilise la boîte partagée contact@ahhamilton.ca
function getUserImapEmail(user) {
  const personal = user?.email_org;
  if (personal && personal.endsWith('@ahhamilton.ca') && personal !== 'contact@ahhamilton.ca') return personal;
  return process.env.ORG_EMAIL || 'contact@ahhamilton.ca';
}

function getUserImapPass(user) {
  return user?.smtp_pass_org || process.env.ORG_SMTP_PASS || '';
}

app.get('/api/email/inbox', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const orgEmail = getUserImapEmail(user);
  const orgPass  = getUserImapPass(user);
  if (!orgPass) return res.status(500).json({ error: 'Mot de passe IMAP non configuré. Définissez votre mot de passe Hostinger dans votre profil.' });
  if (req.query.refresh === '1') imap.invalidateCache(orgEmail);
  try {
    const emails = await imap.fetchEmails(orgEmail, orgPass);
    res.json(emails);
  } catch(e) {
    console.error(`[inbox] ERREUR pour ${orgEmail}:`, e.message);
    res.status(500).json({ error: `Connexion IMAP échouée pour ${orgEmail} : ${e.message}` });
  }
});

app.get('/api/email/inbox/:uid', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const orgEmail = getUserImapEmail(user);
  const orgPass  = getUserImapPass(user);
  if (!orgPass) return res.status(500).json({ error: 'Mot de passe IMAP non configuré' });
  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'UID invalide' });
  try {
    const body = await imap.fetchEmailBody(orgEmail, orgPass, uid);
    res.json({ body });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/email/inbox/:uid/read', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const orgEmail = getUserImapEmail(user);
  const orgPass  = getUserImapPass(user);
  if (!orgPass) return res.status(500).json({ error: 'Mot de passe IMAP non configuré' });
  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'UID invalide' });
  try {
    await imap.markAsRead(orgEmail, orgPass, uid);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/email/inbox/:uid', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const orgEmail = getUserImapEmail(user);
  const orgPass  = getUserImapPass(user);
  if (!orgPass) return res.status(500).json({ error: 'Mot de passe IMAP non configuré' });
  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'UID invalide' });
  try {
    await imap.deleteEmail(orgEmail, orgPass, uid);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/email/inbox', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const orgEmail = getUserImapEmail(user);
  const orgPass  = getUserImapPass(user);
  if (!orgPass) return res.status(500).json({ error: 'Mot de passe IMAP non configuré' });
  const uids = (req.body?.uids || []).map(Number).filter(Boolean);
  if (!uids.length) return res.status(400).json({ error: 'UIDs requis' });
  try {
    const deleted = await imap.deleteBulk(orgEmail, orgPass, uids);
    res.json({ ok: true, deleted });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/reports/volunteer', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const { user_id, activity_id } = req.query;
  let q = `SELECT vh.*, u.prenom, u.nom, u.email, a.titre AS activite
    FROM volunteer_hours vh JOIN users u ON u.id = vh.user_id LEFT JOIN activities a ON a.id = vh.activity_id
    WHERE vh.statut = 'approuve'`;
  const vals = [];
  if (user_id)     { q += ' AND vh.user_id = ?';     vals.push(user_id); }
  if (activity_id) { q += ' AND vh.activity_id = ?'; vals.push(activity_id); }
  q += ' ORDER BY vh.date_service DESC';
  const rows = db.prepare(q).all(...vals);
  const total = rows.reduce((s, r) => s + r.heures, 0);
  res.json({ rows, total_heures: total });
});

app.get('/api/reports/finance', authMiddleware, requireRole('admin', 'tresoriere'), (req, res) => {
  const { activity_id } = req.query;
  const lines = db.prepare(`SELECT fl.*,
    COALESCE((SELECT SUM(montant) FROM transactions WHERE financial_line_id = fl.id AND type='depense'),0) AS depenses,
    COALESCE((SELECT SUM(montant) FROM transactions WHERE financial_line_id = fl.id AND type='revenu'),0) AS revenus,
    a.titre AS activite
    FROM financial_lines fl LEFT JOIN activities a ON a.id = fl.activity_id
    ${activity_id ? 'WHERE fl.activity_id = ?' : ''} ORDER BY fl.date_creation DESC`)
    .all(...(activity_id ? [activity_id] : []));
  const account = db.prepare('SELECT * FROM account_info WHERE id = 1').get();
  res.json({ lines, account });
});

app.get('/api/reports/members', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const members = db.prepare(`SELECT u.id, u.prenom, u.nom, u.email, u.telephone, u.role, u.date_inscription,
    COALESCE((SELECT SUM(heures) FROM volunteer_hours WHERE user_id = u.id AND statut = 'approuve'), 0) AS total_heures,
    (SELECT COUNT(*) FROM activity_registrations WHERE user_id = u.id) AS nb_activites
    FROM users u WHERE u.actif = 1 AND (u.phantom IS NULL OR u.phantom = 0) ORDER BY u.nom`).all();
  res.json(members);
});

// ── Stats publiques (pour la page d'accueil) ─────────────────────────────────
app.get('/api/stats/public', (req, res) => {
  const cfg = db.prepare('SELECT * FROM stats_config WHERE id=1').get() || {};
  const membres_reel    = db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0)").get().c;
  const benevoles_reel  = db.prepare("SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE statut='approuve'").get().c;
  const activites_reel  = db.prepare("SELECT COUNT(*) AS c FROM activities WHERE statut NOT IN ('annulee','archivee')").get().c;
  res.json({
    membres:           cfg.membres_global  ?? membres_reel,
    membres_reel,
    benevoles:         cfg.benevoles_global ?? benevoles_reel,
    benevoles_reel,
    activites:         activites_reel,
    annees:            cfg.annees_service ?? 18,
    show_membres:      cfg.show_membres  ?? 1,
    show_benevoles:    cfg.show_benevoles ?? 1,
  });
});

// ── Configuration des stats (comité) ─────────────────────────────────────────
app.get('/api/stats/config', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const cfg = db.prepare('SELECT * FROM stats_config WHERE id=1').get() || {};
  const membres_reel   = db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0)").get().c;
  const benevoles_reel = db.prepare("SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE statut='approuve'").get().c;
  res.json({ ...cfg, membres_reel, benevoles_reel });
});

app.put('/api/stats/config', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const { membres_global, benevoles_global, annees_service, show_membres, show_benevoles } = req.body;
  db.prepare(`INSERT INTO stats_config (id, membres_global, benevoles_global, annees_service, show_membres, show_benevoles)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      membres_global=excluded.membres_global,
      benevoles_global=excluded.benevoles_global,
      annees_service=excluded.annees_service,
      show_membres=excluded.show_membres,
      show_benevoles=excluded.show_benevoles`)
    .run(
      membres_global  !== undefined ? (membres_global  === '' ? null : parseInt(membres_global))  : null,
      benevoles_global !== undefined ? (benevoles_global === '' ? null : parseInt(benevoles_global)) : null,
      parseInt(annees_service) || 18,
      show_membres  ? 1 : 0,
      show_benevoles ? 1 : 0
    );
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// STATS (dashboard home)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', authMiddleware, (req, res) => {
  const stats = {
    total_membres:    db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND role='member'").get().c,
    total_activites:  db.prepare("SELECT COUNT(*) AS c FROM activities WHERE statut != 'annulee'").get().c,
    total_heures:     db.prepare("SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE statut='approuve'").get().c,
    messages_non_lus: db.prepare("SELECT COUNT(*) AS c FROM message_recipients WHERE destinataire_id=? AND lu=0").get(req.user.id).c,
    alertes_non_lues: db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE destinataire_id=? AND lu=0").get(req.user.id).c,
    prochaines_activites: db.prepare("SELECT id, titre, date_debut, lieu, (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=activities.id) AS nb_inscrits FROM activities WHERE statut='planifiee' ORDER BY date_debut LIMIT 5").all(),
    derniers_membres: db.prepare("SELECT id, prenom, nom, date_inscription FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0) ORDER BY date_inscription DESC LIMIT 4").all(),
  };
  if (['admin','tresoriere'].includes(req.user.role)) {
    const acc = db.prepare('SELECT solde FROM account_info WHERE id=1').get();
    stats.solde = acc?.solde || 0;
  }
  res.json(stats);
});

// ══════════════════════════════════════════════════════════════════════════════
// GALLERY PHOTOS (gestion par admin + secrétaire)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/hero-images', (req, res) => {
  const dir = path.join(__dirname, 'Public', 'Fond');
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  try {
    const files = fs.readdirSync(dir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(f => '/Public/Fond/' + encodeURIComponent(f));
    res.json(files.length ? files : ['/Public/fond.jpg']);
  } catch(e) {
    res.json(['/Public/fond.jpg']);
  }
});

app.get('/api/gallery', (req, res) => {
  const rows = db.prepare(`
    SELECT gp.*, u.prenom || ' ' || u.nom AS uploadeur
    FROM gallery_photos gp LEFT JOIN users u ON u.id = gp.cree_par
    WHERE gp.actif = 1 ORDER BY gp.date_upload DESC
  `).all();
  res.json(rows);
});

app.post('/api/gallery', authMiddleware, requireRole('admin', 'secretaire'),
  uploadGallery.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Photo requise' });
    const { titre, categorie } = req.body;
    const photo_path = `/uploads/gallery/${req.file.filename}`;
    const r = db.prepare(`INSERT INTO gallery_photos (titre, categorie, photo_path, cree_par)
      VALUES (?, ?, ?, ?)`).run(titre || '', categorie || 'general', photo_path, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, photo_path });
  }
);

app.get('/api/gallery/featured', (req, res) => {
  const featured = db.prepare(`
    SELECT gp.*, u.prenom || ' ' || u.nom AS uploadeur
    FROM gallery_photos gp LEFT JOIN users u ON u.id = gp.cree_par
    WHERE gp.actif = 1 AND gp.featured = 1 ORDER BY gp.date_upload DESC
  `).all();
  if (featured.length) return res.json(featured);
  // Fallback : 6 photos les plus récentes si aucune mise en avant
  const recent = db.prepare(`
    SELECT gp.*, u.prenom || ' ' || u.nom AS uploadeur
    FROM gallery_photos gp LEFT JOIN users u ON u.id = gp.cree_par
    WHERE gp.actif = 1 ORDER BY gp.date_upload DESC LIMIT 6
  `).all();
  res.json(recent);
});

app.patch('/api/gallery/:id/featured', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const photo = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  const newVal = photo.featured ? 0 : 1;
  db.prepare('UPDATE gallery_photos SET featured = ? WHERE id = ?').run(newVal, photo.id);
  res.json({ featured: newVal });
});

app.delete('/api/gallery/:id', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const photo = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  // Supprimer le fichier physique
  const filePath = path.join(__dirname, photo.photo_path);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM gallery_photos WHERE id = ?').run(req.params.id);
  res.json({ message: 'Photo supprimée' });
});

// ── Annuaire membres (accessible à tous) ────────────────────────────────────
app.get('/api/annuaire', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT id, prenom, nom, email, telephone, role
    FROM users WHERE actif = 1 ORDER BY nom, prenom
  `).all();
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════════════════════════

// GET rooms for current user
app.get('/api/chat/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare(`
    SELECT cr.*, crm.last_read_at,
      (SELECT COUNT(*) FROM chat_messages cm
       WHERE cm.room_id = cr.id
       AND cm.created_at > COALESCE(crm.last_read_at, '1970-01-01')) AS unread,
      (SELECT cm2.content FROM chat_messages cm2
       WHERE cm2.room_id = cr.id ORDER BY cm2.created_at DESC LIMIT 1) AS last_msg,
      (SELECT cm2.created_at FROM chat_messages cm2
       WHERE cm2.room_id = cr.id ORDER BY cm2.created_at DESC LIMIT 1) AS last_msg_at
    FROM chat_rooms cr
    JOIN chat_room_members crm ON crm.room_id = cr.id AND crm.user_id = ?
    ORDER BY COALESCE(last_msg_at, cr.created_at) DESC
  `).all(req.user.id);
  res.json(rooms);
});

// GET messages for a room (+ mark read)
app.get('/api/chat/rooms/:id/messages', authMiddleware, (req, res) => {
  // Check access
  const member = db.prepare('SELECT * FROM chat_room_members WHERE room_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Accès refusé' });

  const afterId = parseInt(req.query.after_id, 10);
  const since = req.query.since || '1970-01-01';
  const query = afterId
    ? `SELECT cm.*, u.prenom, u.nom, u.role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
       WHERE cm.room_id = ? AND cm.id > ?
       ORDER BY cm.id ASC LIMIT 100`
    : `SELECT cm.*, u.prenom, u.nom, u.role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
       WHERE cm.room_id = ? AND cm.created_at > ?
       ORDER BY cm.created_at ASC LIMIT 100`;
  const msgs = db.prepare(query).all(req.params.id, afterId || since);

  // Mark as read
  db.prepare('UPDATE chat_room_members SET last_read_at = CURRENT_TIMESTAMP WHERE room_id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);

  res.json(msgs);
});

// POST message to a room
app.post('/api/chat/rooms/:id/messages', authMiddleware, (req, res) => {
  const member = db.prepare('SELECT * FROM chat_room_members WHERE room_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Accès refusé' });

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });

  const r = db.prepare('INSERT INTO chat_messages (room_id, sender_id, content) VALUES (?, ?, ?)')
    .run(req.params.id, req.user.id, content.trim());

  db.prepare('UPDATE chat_room_members SET last_read_at = CURRENT_TIMESTAMP WHERE room_id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);

  res.status(201).json({ id: r.lastInsertRowid });
});

// POST create a group room (committee only)
app.post('/api/chat/rooms', authMiddleware, requireRole('admin', 'secretaire', 'tresoriere', 'delegue'), (req, res) => {
  const { name, member_ids, activity_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });

  const r = db.prepare('INSERT INTO chat_rooms (name, type, activity_id, created_by) VALUES (?, ?, ?, ?)')
    .run(name.trim(), 'group', activity_id || null, req.user.id);

  const roomId = r.lastInsertRowid;
  const addMember = db.prepare('INSERT OR IGNORE INTO chat_room_members (room_id, user_id) VALUES (?, ?)');

  // Always add creator
  addMember.run(roomId, req.user.id);

  // Add selected members
  if (Array.isArray(member_ids)) {
    member_ids.forEach(uid => addMember.run(roomId, uid));
  }

  res.status(201).json({ id: roomId });
});

// DELETE a group room (committee only)
app.delete('/api/chat/rooms/:id', authMiddleware, requireRole('admin', 'secretaire', 'tresoriere', 'delegue'), (req, res) => {
  const room = db.prepare('SELECT * FROM chat_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Salon introuvable' });
  if (['general', 'committee'].includes(room.type)) return res.status(403).json({ error: 'Salon système non supprimable' });
  db.prepare('DELETE FROM chat_rooms WHERE id = ?').run(req.params.id);
  res.json({ message: 'Salon supprimé' });
});

// GET or CREATE private chat between two users
app.post('/api/chat/private', authMiddleware, (req, res) => {
  const { target_id } = req.body;
  if (!target_id) return res.status(400).json({ error: 'Utilisateur requis' });

  const target = db.prepare('SELECT id, prenom, nom FROM users WHERE id = ? AND actif = 1').get(target_id);
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Check if private room already exists
  const existing = db.prepare(`
    SELECT cr.id FROM chat_rooms cr
    JOIN chat_room_members m1 ON m1.room_id = cr.id AND m1.user_id = ?
    JOIN chat_room_members m2 ON m2.room_id = cr.id AND m2.user_id = ?
    WHERE cr.type = 'private'
    AND (SELECT COUNT(*) FROM chat_room_members WHERE room_id = cr.id) = 2
    LIMIT 1
  `).get(req.user.id, target_id);

  if (existing) return res.json({ id: existing.id });

  const myUser = db.prepare('SELECT prenom, nom FROM users WHERE id = ?').get(req.user.id);
  const name = `💬 ${myUser.prenom} & ${target.prenom}`;
  const r = db.prepare('INSERT INTO chat_rooms (name, type, created_by) VALUES (?, ?, ?)').run(name, 'private', req.user.id);
  const addMember = db.prepare('INSERT OR IGNORE INTO chat_room_members (room_id, user_id) VALUES (?, ?)');
  addMember.run(r.lastInsertRowid, req.user.id);
  addMember.run(r.lastInsertRowid, target_id);

  res.status(201).json({ id: r.lastInsertRowid });
});

// GET members of a room
app.get('/api/chat/rooms/:id/members', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.prenom, u.nom, u.role FROM chat_room_members crm
    JOIN users u ON u.id = crm.user_id WHERE crm.room_id = ?
  `).all(req.params.id);
  res.json(rows);
});

// GET all users (for private/group chat selection)
app.get('/api/chat/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, prenom, nom, role FROM users WHERE actif = 1 AND id != ? ORDER BY prenom')
    .all(req.user.id);
  res.json(users);
});

// GET total unread count
app.get('/api/chat/unread', authMiddleware, (req, res) => {
  const { count } = db.prepare(`
    SELECT SUM(sub.unread) AS count FROM (
      SELECT COUNT(*) AS unread FROM chat_messages cm
      JOIN chat_room_members crm ON crm.room_id = cm.room_id AND crm.user_id = ?
      WHERE cm.created_at > COALESCE(crm.last_read_at, '1970-01-01')
      AND cm.sender_id != ?
    ) sub
  `).get(req.user.id, req.user.id);
  res.json({ count: count || 0 });
});

// ══════════════════════════════════════════════════════════════════════════════
// PASSWORD RESET (forgot / reset)
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const user = db.prepare('SELECT id, prenom, nom FROM users WHERE email = ? AND actif = 1').get(email);
  if (!user) return res.json({ message: 'Si cet email existe, un lien a été envoyé.' }); // security: don't reveal

  // Expire old tokens
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 3600000).toISOString(); // 1h
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expires);

  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  const resetLink = `${siteUrl}/dashboard/reset-password.html?token=${token}`;

  mailer.sendResetPassword(user, resetLink).catch(e => console.error('Email error:', e.message));
  console.log(`\n🔑 RESET LINK: ${resetLink}\n`);

  res.json({ message: 'Si cet email existe, un lien a été envoyé.' });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.status(400).json({ error: 'Données manquantes' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min. 6 caractères)' });

  const row = db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0`).get(token);
  if (!row) return res.status(400).json({ error: 'Lien invalide ou déjà utilisé' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Lien expiré' });

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);

  res.json({ message: 'Mot de passe réinitialisé avec succès' });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC ACTIVITIES (no auth required)
// ══════════════════════════════════════════════════════════════════════════════

// GET — activité à la une (public)
app.get('/api/activities/featured', (req, res) => {
  const act = db.prepare(`
    SELECT a.id, a.titre, a.description, a.type, a.date_debut, a.date_fin, a.lieu,
      a.prix, a.paiement_requis, a.max_participants, a.statut, a.qr_token,
      (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = a.id) AS nb_inscrits,
      (SELECT photo_path FROM activity_photos WHERE activity_id = a.id ORDER BY ordre ASC, id ASC LIMIT 1) AS flyer
    FROM activities a
    WHERE a.featured = 1 AND a.statut NOT IN ('archivee','annulee')
    LIMIT 1`).get();
  if (!act) return res.json(null);
  res.json(act);
});

// PATCH — mettre une activité à la une (admin/secrétaire)
app.patch('/api/activities/:id/feature', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE activities SET featured = 0').run(); // enlever l'ancienne
  db.prepare('UPDATE activities SET featured = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PATCH — retirer de la une
app.patch('/api/activities/:id/unfeature', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE activities SET featured = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/activities/public', (req, res) => {
  const rows = db.prepare(`
    SELECT id, titre, description, type, date_debut, date_fin, lieu, max_participants, statut, prix, paiement_requis,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = activities.id) AS nb_inscrits,
    (SELECT photo_path FROM activity_photos WHERE activity_id = activities.id ORDER BY ordre ASC, id ASC LIMIT 1) AS thumbnail
    FROM activities WHERE statut IN ('planifiee','en_cours')
    ORDER BY date_debut ASC
  `).all();
  res.json(rows);
});

app.get('/api/activities/public/past', (req, res) => {
  const rows = db.prepare(`
    SELECT id, titre, description, type, date_debut, date_fin, lieu, max_participants, statut,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = activities.id) AS nb_inscrits,
    (SELECT photo_path FROM activity_photos WHERE activity_id = activities.id ORDER BY ordre ASC, id ASC LIMIT 1) AS thumbnail
    FROM activities WHERE statut = 'terminee'
    ORDER BY date_debut DESC LIMIT 12
  `).all();
  res.json(rows);
});

// ── Activity Photos ───────────────────────────────────────────────────────────
app.get('/api/activities/:id/photos', (req, res) => {
  const photos = db.prepare(
    'SELECT * FROM activity_photos WHERE activity_id = ? ORDER BY ordre ASC, id ASC'
  ).all(parseInt(req.params.id));
  res.json(photos);
});

app.post('/api/activities/:id/photos', authMiddleware, requireRole('admin','secretaire','delegue','tresoriere'),
  uploadActivityPhoto.array('photos', 20), (req, res) => {
  const actId = parseInt(req.params.id);
  const act = db.prepare('SELECT id FROM activities WHERE id = ?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  const inserted = [];
  (req.files || []).forEach((f, i) => {
    const photoPath = `/uploads/activities/${actId}/${f.filename}`;
    const r = db.prepare('INSERT INTO activity_photos (activity_id, photo_path, ordre, cree_par) VALUES (?,?,?,?)')
      .run(actId, photoPath, i, req.user.id);
    inserted.push({ id: r.lastInsertRowid, photo_path: photoPath });
  });
  res.status(201).json(inserted);
});

app.delete('/api/activity-photos/:id', authMiddleware, requireRole('admin','secretaire','delegue','tresoriere'), (req, res) => {
  const photo = db.prepare('SELECT * FROM activity_photos WHERE id = ?').get(parseInt(req.params.id));
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  try {
    const fullPath = path.join(__dirname, photo.photo_path);
    if (require('fs').existsSync(fullPath)) require('fs').unlinkSync(fullPath);
  } catch {}
  db.prepare('DELETE FROM activity_photos WHERE id = ?').run(photo.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CONTACT FORM
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/contact', (req, res) => {
  const { nom, email, sujet, message } = req.body;
  if (!nom || !email || !message) return res.status(400).json({ error: 'Champs requis manquants' });

  // Create internal message to all admins
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND actif = 1").all();
  if (admins.length) {
    // Find or create a "system" sender — use first admin as proxy
    const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?, ?, ?, 'individuel')")
      .run(admins[0].id, `[Site public] ${sujet || 'Contact'} – ${nom}`, `De: ${nom} <${email}>\n\n${message}`);
    const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?, ?)');
    admins.forEach(a => ins.run(r.lastInsertRowid, a.id));
  }

  mailer.sendContact({ nom, email, sujet, message }).catch(e => console.error('Email error:', e.message));

  res.json({ message: 'Message envoyé avec succès' });
});

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL SEARCH
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/search', authMiddleware, (req, res) => {
  const q = `%${req.query.q || ''}%`;
  if (!req.query.q || req.query.q.length < 2) return res.json({ members:[], activities:[], notes:[] });

  const members = ['admin','secretaire'].includes(req.user.role)
    ? db.prepare(`SELECT id, prenom, nom, email, role FROM users WHERE actif=1 AND (prenom LIKE ? OR nom LIKE ? OR email LIKE ?) LIMIT 8`).all(q,q,q)
    : [];

  const activities = db.prepare(`SELECT id, titre, description, type, date_debut, statut FROM activities
    WHERE titre LIKE ? OR description LIKE ? OR lieu LIKE ? LIMIT 8`).all(q,q,q);

  const notes = db.prepare(`SELECT id, titre, contenu, date_reunion FROM meeting_notes
    WHERE (auteur_id = ? OR ? IN ('admin','secretaire','tresoriere','delegue'))
    AND (titre LIKE ? OR contenu LIKE ?) LIMIT 6`).all(req.user.id, req.user.role, q, q);

  res.json({ members, activities, notes });
});

// Recherche publique (sans auth) — activités, talents, annonces
app.get('/api/search/public', (req, res) => {
  const raw = (req.query.q || '').trim();
  if (raw.length < 2) return res.json([]);
  const q = `%${raw}%`;
  const activities = db.prepare(`SELECT 'activite' AS type, id, titre AS title,
    description AS desc, date_debut AS date, lieu AS sub FROM activities
    WHERE statut != 'annulee' AND (titre LIKE ? OR description LIKE ? OR lieu LIKE ?) LIMIT 6`).all(q,q,q);
  const talents = db.prepare(`SELECT 'talent' AS type, id, nom AS title,
    description AS desc, NULL AS date, categorie AS sub FROM talents
    WHERE statut = 'approuve' AND (nom LIKE ? OR description LIKE ? OR categorie LIKE ?) LIMIT 6`).all(q,q,q);
  const annonces = db.prepare(`SELECT 'annonce' AS type, id, titre AS title,
    description AS desc, NULL AS date, categorie AS sub FROM annonces
    WHERE statut = 'approuve' AND (titre LIKE ? OR description LIKE ? OR categorie LIKE ?) LIMIT 6`).all(q,q,q);
  res.json([...activities, ...talents, ...annonces]);
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE ATTACHMENTS (multer)
// ══════════════════════════════════════════════════════════════════════════════

const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'attachments');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadAttachment = multer({ storage: attachmentStorage, limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/messages/with-attachment', authMiddleware, uploadAttachment.single('attachment'), (req, res) => {
  const { sujet, contenu, destinataires } = req.body;
  if (!contenu || !destinataires) return res.status(400).json({ error: 'Contenu et destinataires requis' });

  let targets;
  try { targets = JSON.parse(destinataires); } catch { return res.status(400).json({ error: 'Destinataires invalides' }); }
  if (!targets.length) return res.status(400).json({ error: 'Au moins un destinataire requis' });

  const attachment_path = req.file ? `/uploads/attachments/${req.file.filename}` : null;
  const attachment_name = req.file ? req.file.originalname : null;

  const r = db.prepare('INSERT INTO messages (expediteur_id, sujet, contenu, type, attachment_path, attachment_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, sujet||'', contenu, targets.length > 1 ? 'rafale' : 'individuel', attachment_path, attachment_name);

  const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?, ?)');
  targets.forEach(id => ins.run(r.lastInsertRowid, id));

  res.status(201).json({ id: r.lastInsertRowid, nb_destinataires: targets.length });
});

app.use('/uploads/attachments', express.static(path.join(__dirname, 'uploads', 'attachments')));

// ══════════════════════════════════════════════════════════════════════════════
// TALENTS
// ══════════════════════════════════════════════════════════════════════════════

const talentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'talents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadTalent = multer({ storage: talentStorage, limits: { fileSize: 8 * 1024 * 1024 } });

// ── Règles de plan ────────────────────────────────────────────────────────────
// perMonth = créations autorisées par mois calendaire
// max      = cumul total actif autorisé
// renewMonths = durée avant message de renouvellement
const PLAN_RULES = {
  gratuit:     { talents:{ perMonth:0, max:0 },  annonces:{ perMonth:0, max:0 }  },
  bienfaiteur: { talents:{ perMonth:1, max:3, renewMonths:6 }, annonces:{ perMonth:2, max:6,  renewMonths:3 } },
  partenaire:  { talents:{ perMonth:3, max:6, renewMonths:6 }, annonces:{ perMonth:4, max:8,  renewMonths:3 } },
  admin:       { talents:{ perMonth:999,max:999,renewMonths:6},annonces:{ perMonth:999,max:999,renewMonths:3}},
};

function isPlanOk(userId) {
  const u = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  return u && ['bienfaiteur','partenaire'].includes(u.plan);
}

// Renvoie { ok, msg, quotaMonth, quotaTotal } pour un userId + table + clé règle
function checkLimit(userId, table, ruleKey) {
  const u = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  if (!u) return { ok:false, msg:'Utilisateur introuvable' };

  const plan  = u.plan || 'gratuit';
  const rules = PLAN_RULES[plan] || PLAN_RULES.gratuit;
  const rule  = rules[ruleKey];
  if (!rule || rule.max === 999) return { ok:true, quotaMonth:999, quotaTotal:999 };

  // Total actifs (non retirés)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND statut NOT IN ('retire')`).get(userId).n;

  // Créations ce mois-ci
  const now = new Date();
  const yStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const monthly = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND substr(date_creation,1,7) = ?`).get(userId, yStr).n;

  if (total >= rule.max)
    return { ok:false, msg:`Limite globale atteinte pour votre plan ${plan} : ${rule.max} maximum actif(s).`, quotaMonth:rule.perMonth - monthly, quotaTotal:rule.max - total };
  if (monthly >= rule.perMonth)
    return { ok:false, msg:`Limite mensuelle atteinte pour votre plan ${plan} : ${rule.perMonth} par mois. Revenez le mois prochain.`, quotaMonth:0, quotaTotal:rule.max - total };

  return { ok:true, quotaMonth:rule.perMonth - monthly, quotaTotal:rule.max - total };
}

// ── Job de renouvellement (tourne toutes les 24h) ────────────────────────────
function runRenewalJob() {
  const now = new Date();

  // Talents : renouvellement après renewMonths selon le plan
  const allTalents = db.prepare(`
    SELECT t.*, u.prenom, u.nom, u.email, u.plan
    FROM talents t JOIN users u ON u.id = t.user_id
    WHERE t.statut = 'approuve' AND (t.notif_renouv IS NULL OR t.notif_renouv = 0)
  `).all();

  allTalents.forEach(t => {
    const plan = t.plan || 'bienfaiteur';
    const rule = (PLAN_RULES[plan] || {}).talents;
    if (!rule || !rule.renewMonths) return;
    const created = new Date(t.date_creation);
    const months  = (now - created) / (1000 * 60 * 60 * 24 * 30.44);
    if (months < rule.renewMonths) return;

    // Notifier le membre
    const msgMember = `🔔 Renouvellement de votre fiche talent\n\nVotre fiche « ${t.nom} » a été publiée il y a ${rule.renewMonths} mois.\n\nSouhaitez-vous la renouveler, la modifier ou la retirer ? Connectez-vous à votre espace membre pour gérer votre fiche.`;
    const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (adminId) {
      const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
        .run(adminId.id, `🔔 Renouvellement talent : ${t.nom}`, msgMember);
      db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(r.lastInsertRowid, t.user_id);
    }
    createAlert(t.user_id, 'talent', `🔔 Renouvelez votre fiche talent`, `Votre fiche « ${t.nom} » a ${rule.renewMonths} mois.`);

    // Notifier les admins
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif = 1").all();
    const msgAdmin = `📋 Rappel renouvellement talent\n\nLa fiche « ${t.nom} » de ${t.prenom} ${t.nom_} (${t.email}) a été publiée il y a ${rule.renewMonths} mois. Le membre a été notifié.`;
    admins.forEach(a => createAlert(a.id, 'talent', `📋 Rappel talent à renouveler : ${t.nom}`, `Publié il y a ${rule.renewMonths} mois par ${t.prenom} ${t.nom}`));

    db.prepare('UPDATE talents SET notif_renouv = 1 WHERE id = ?').run(t.id);
  });

  // Annonces : renouvellement selon plan
  const allAnnonces = db.prepare(`
    SELECT a.*, u.prenom, u.nom, u.email, u.plan
    FROM annonces a JOIN users u ON u.id = a.user_id
    WHERE a.statut = 'approuve' AND (a.notif_renouv IS NULL OR a.notif_renouv = 0)
  `).all();

  allAnnonces.forEach(a => {
    const plan = a.plan || 'bienfaiteur';
    const rule = (PLAN_RULES[plan] || {}).annonces;
    if (!rule || !rule.renewMonths) return;
    const created = new Date(a.date_creation);
    const months  = (now - created) / (1000 * 60 * 60 * 24 * 30.44);
    if (months < rule.renewMonths) return;

    const msgMember = `🔔 Renouvellement de votre annonce\n\nVotre annonce « ${a.titre} » a été publiée il y a ${rule.renewMonths} mois.\n\nSouhaitez-vous la renouveler, la modifier ou la retirer ? Connectez-vous à votre espace membre.`;
    const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (adminId) {
      const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
        .run(adminId.id, `🔔 Renouvellement annonce : ${a.titre}`, msgMember);
      db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(r.lastInsertRowid, a.user_id);
    }
    createAlert(a.user_id, 'annonce', `🔔 Renouvelez votre annonce`, `Votre annonce « ${a.titre} » a ${rule.renewMonths} mois.`);

    const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif = 1").all();
    admins.forEach(adm => createAlert(adm.id, 'annonce', `📋 Rappel annonce à renouveler : ${a.titre}`, `Publiée il y a ${rule.renewMonths} mois par ${a.prenom} ${a.nom}`));

    db.prepare('UPDATE annonces SET notif_renouv = 1 WHERE id = ?').run(a.id);
  });

  if (allTalents.length + allAnnonces.length > 0)
    console.log(`✅ Job renouvellement : ${allTalents.length} talents + ${allAnnonces.length} annonces vérifiés`);

  // Cartes de membre : rappel 30 jours avant expiration (2 ans après date_inscription)
  const membres = db.prepare(`SELECT * FROM users WHERE actif=1 AND role='member'
    AND (phantom IS NULL OR phantom=0) AND (carte_notif_renouv IS NULL OR carte_notif_renouv=0)
    AND date_inscription IS NOT NULL`).all();
  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id;
  membres.forEach(m => {
    const inscrit = new Date(m.date_inscription);
    const expiration = new Date(inscrit.getFullYear() + 2, inscrit.getMonth(), inscrit.getDate());
    const daysLeft = Math.ceil((expiration - now) / 86400000);
    if (daysLeft > 30 || daysLeft < 0) return;
    mailer.sendCarteRenewal(m, expiration.toISOString().split('T')[0]).catch(() => {});
    if (adminId) createAlert(adminId, 'carte',
      `🪪 Carte expire dans ${daysLeft}j : ${m.prenom} ${m.nom}`,
      `Membre #${String(m.id).padStart(5,'0')} — Renouveler depuis Gestion des cartes`);
    db.prepare('UPDATE users SET carte_notif_renouv=1 WHERE id=?').run(m.id);
    console.log(`[CARTE] rappel envoyé à ${m.email} (expire dans ${daysLeft}j)`);
  });
}

// Lancer le job renouvellements toutes les 24h
setTimeout(() => { runRenewalJob(); setInterval(runRenewalJob, 24 * 60 * 60 * 1000); }, 60000);

// Nettoyage automatique : supprimer les inscriptions traitées de plus de 10 jours
function purgeOldInscriptions() {
  const result = db.prepare(`DELETE FROM pending_registrations WHERE statut != 'en_attente' AND date_traitement < datetime('now', '-10 days')`).run();
  if (result.changes > 0) console.log(`[PURGE] ${result.changes} inscription(s) traitée(s) supprimée(s) (>10 jours)`);
}
setTimeout(() => { purgeOldInscriptions(); setInterval(purgeOldInscriptions, 24 * 60 * 60 * 1000); }, 90000);

// ══════════════════════════════════════════════════════════════════════════════
// PAIEMENTS MEMBRES
// ══════════════════════════════════════════════════════════════════════════════

const paymentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'payments');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadPayment = multer({ storage: paymentStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const PLAN_PRIX = { bienfaiteur: 10, partenaire: 20 };

// GET — ses propres paiements
app.get('/api/payments/my', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY date_soumission DESC').all(req.user.id));
});

// GET — tous les paiements (finance)
app.get('/api/payments', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const rows = db.prepare(`SELECT p.*, u.prenom, u.nom, u.email, u.plan
    FROM payments p LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.date_soumission DESC`).all();
  res.json(rows);
});

// POST — soumettre un paiement ou don
app.post('/api/payments', authMiddleware, uploadPayment.single('proof'), (req, res) => {
  const { montant, type, mois, methode, reference, note } = req.body;
  if (!montant) return res.status(400).json({ error: 'Montant requis' });
  const proof_path = req.file ? `/uploads/payments/${req.file.filename}` : null;
  const r = db.prepare(`INSERT INTO payments (user_id, montant, type, mois, methode, reference, proof_path, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, parseFloat(montant), type||'mensualite', mois||'', methode||'virement', reference||'', proof_path, note||'');

  // Notifier trésorière + présidente + VP
  const finance = db.prepare("SELECT id FROM users WHERE role IN ('admin','tresoriere') AND actif=1").all();
  const u = db.prepare('SELECT prenom, nom, plan FROM users WHERE id = ?').get(req.user.id);
  const typeLabel = type === 'don' ? 'Don' : 'Mensualité';
  const contenu = `${typeLabel} reçu — ${u.prenom} ${u.nom}\n\nMontant : $${montant}\nMois : ${mois||'–'}\nMéthode : ${methode||'–'}\nRéférence : ${reference||'–'}\nNote : ${note||'–'}\n\nDashboard → Paiements pour approuver.`;
  const adminId = finance[0]?.id || 1;
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `💳 ${typeLabel} à valider — ${u.prenom} ${u.nom} ($${montant})`, contenu);
  const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)');
  finance.forEach(f => { ins.run(msgR.lastInsertRowid, f.id); createAlert(f.id,'paiement',`💳 ${typeLabel} à approuver : ${u.prenom} ${u.nom}`,`$${montant}`); });

  res.status(201).json({ id: r.lastInsertRowid });
});
app.use('/uploads/payments', express.static(path.join(__dirname, 'uploads', 'payments')));

// PATCH — approuver un paiement
app.patch('/api/payments/:id/approuver', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });

  db.prepare('UPDATE payments SET statut=?, approuve_par=?, date_approbation=CURRENT_TIMESTAMP WHERE id=?')
    .run('approuve', req.user.id, pay.id);

  // Mettre à jour plan_paid_month et réinitialiser compteur impayé
  const mois = pay.mois || new Date().toISOString().substring(0,7);
  db.prepare('UPDATE users SET plan_paid_month=?, plan_unpaid_count=0 WHERE id=?').run(mois, pay.user_id);

  // Notifier le membre
  const u = db.prepare('SELECT prenom, nom FROM users WHERE id=?').get(pay.user_id);
  const typeLabel = pay.type === 'don' ? 'Don' : 'Mensualité';
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `✅ ${typeLabel} approuvé — $${pay.montant}`,
      `Votre ${typeLabel.toLowerCase()} de $${pay.montant} a été approuvé et enregistré.\n\nMois : ${mois}\nMerci pour votre contribution à l'Association Haïtienne de Hamilton !`);
  db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, pay.user_id);
  createAlert(pay.user_id, 'paiement', `✅ ${typeLabel} approuvé`, `$${pay.montant} enregistré`);

  const membre = db.prepare('SELECT * FROM users WHERE id=?').get(pay.user_id);
  if (membre) mailer.sendPaiementApprouve(membre, pay.montant, mois).catch(()=>{});

  res.json({ message: 'Paiement approuvé' });
});

// PATCH — rejeter un paiement
app.patch('/api/payments/:id/rejeter', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const { raison } = req.body;
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
  db.prepare('UPDATE payments SET statut=?, approuve_par=?, date_approbation=CURRENT_TIMESTAMP WHERE id=?')
    .run('rejete', req.user.id, pay.id);
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `❌ Paiement non validé`,
      `Votre paiement de $${pay.montant} n'a pas pu être validé.\n\nRaison : ${raison||'–'}\nVeuillez contacter l'administration.`);
  db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, pay.user_id);
  res.json({ message: 'Paiement refusé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// REÇUS FISCAUX
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/receipts/my', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM tax_receipts WHERE user_id = ? ORDER BY annee DESC').all(req.user.id));
});

app.get('/api/receipts', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const rows = db.prepare(`SELECT r.*, u.prenom, u.nom, u.email
    FROM tax_receipts r JOIN users u ON u.id = r.user_id
    ORDER BY r.annee DESC, r.date_generation DESC`).all();
  res.json(rows);
});

app.post('/api/receipts', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const { user_id, annee } = req.body;
  if (!user_id || !annee) return res.status(400).json({ error: 'user_id et annee requis' });

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  if (!u) return res.status(404).json({ error: 'Membre introuvable' });

  // Calculer le total des dons/paiements approuvés pour l'année
  const total = db.prepare(`SELECT COALESCE(SUM(montant),0) AS total FROM payments
    WHERE user_id=? AND statut='approuve' AND substr(date_soumission,1,4)=?`)
    .get(user_id, String(annee)).total;

  const contenu = `REÇU FISCAL ${annee}\nAssociation Haïtienne de Hamilton\n231 Fernwood Crescent, Hamilton, ON L8T 3L7\n\nRemis à : ${u.prenom} ${u.nom}\nCourriel : ${u.email}\n\nDons et cotisations approuvés pour ${annee} : $${total.toFixed(2)}\n\nCe reçu confirme les contributions à l'Association Haïtienne de Hamilton pour l'année fiscale ${annee}.\n\nSigné par : ${req.user.prenom} ${req.user.nom}`;

  const print_token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare('INSERT INTO tax_receipts (user_id, annee, montant_total, genere_par, contenu, print_token) VALUES (?,?,?,?,?,?)')
    .run(user_id, annee, total, req.user.id, contenu, print_token);

  // Envoyer le reçu au membre
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `🧾 Votre reçu fiscal ${annee} — AHH`, contenu);
  db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, user_id);
  createAlert(user_id, 'paiement', `🧾 Reçu fiscal ${annee} disponible`, `Total: $${total.toFixed(2)}`);
  mailer.sendRecuFiscal(u, annee, total, r.lastInsertRowid, print_token).catch(()=>{});

  res.status(201).json({ id: r.lastInsertRowid, montant_total: total, contenu });
});

// Aperçu des montants par membre pour une année donnée
app.get('/api/receipts/preview', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const { annee, ids } = req.query;
  if (!annee) return res.status(400).json({ error: 'annee requis' });
  const idList = ids ? ids.split(',').map(Number).filter(Boolean) : [];
  let membres = db.prepare('SELECT id, prenom, nom, email, plan, role FROM users WHERE actif=1').all();
  if (idList.length) membres = membres.filter(m => idList.includes(m.id));
  const result = membres.map(m => {
    const total = db.prepare(`SELECT COALESCE(SUM(montant),0) AS t FROM payments WHERE user_id=? AND statut='approuve' AND substr(date_soumission,1,4)=?`).get(m.id, String(annee)).t;
    return { ...m, total_paiements: total };
  });
  res.json(result);
});

// Génération en lot de reçus fiscaux
app.post('/api/receipts/bulk', authMiddleware, requireRole('admin','tresoriere'), async (req, res) => {
  const { user_ids, annee } = req.body;
  if (!user_ids?.length || !annee) return res.status(400).json({ error: 'user_ids et annee requis' });
  const results = [];
  for (const user_id of user_ids) {
    try {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
      if (!u) continue;
      const total = db.prepare(`SELECT COALESCE(SUM(montant),0) AS t FROM payments WHERE user_id=? AND statut='approuve' AND substr(date_soumission,1,4)=?`).get(user_id, String(annee)).t;
      const contenu = `REÇU FISCAL ${annee}\nAssociation Haïtienne de Hamilton\n231 Fernwood Crescent, Hamilton, ON L8T 3L7\n\nRemis à : ${u.prenom} ${u.nom}\nCourriel : ${u.email}\n\nDons et cotisations approuvés pour ${annee} : $${total.toFixed(2)}\n\nCe reçu confirme les contributions à l'Association Haïtienne de Hamilton pour l'année fiscale ${annee}.\n\nSigné par : ${req.user.prenom} ${req.user.nom}`;
      const print_token = crypto.randomBytes(24).toString('hex');
      const r = db.prepare('INSERT INTO tax_receipts (user_id, annee, montant_total, genere_par, contenu, print_token) VALUES (?,?,?,?,?,?)').run(user_id, annee, total, req.user.id, contenu, print_token);
      const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')").run(req.user.id, `🧾 Votre reçu fiscal ${annee} — AHH`, contenu);
      db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, user_id);
      createAlert(user_id, 'paiement', `🧾 Reçu fiscal ${annee} disponible`, `Total: $${total.toFixed(2)}`);
      mailer.sendRecuFiscal(u, annee, total, r.lastInsertRowid, print_token).catch(() => {});
      results.push({ user_id, nom: `${u.prenom} ${u.nom}`, montant: total, ok: true });
    } catch(e) {
      results.push({ user_id, ok: false, error: e.message });
    }
  }
  res.json({ generated: results.filter(r => r.ok).length, results });
});

// Reçu fiscal — page HTML imprimable (token public OU JWT)
app.get('/api/receipts/:id/print', (req, res) => {
  const r = db.prepare(`SELECT tr.*, u.prenom, u.nom, u.email, u.adresse, u.telephone,
    g.prenom AS gen_prenom, g.nom AS gen_nom
    FROM tax_receipts tr
    JOIN users u ON u.id = tr.user_id
    LEFT JOIN users g ON g.id = tr.genere_par
    WHERE tr.id = ?`).get(req.params.id);
  if (!r) return res.status(404).send('Reçu introuvable');

  const { token } = req.query;
  if (token) {
    // Accès par lien email — valider le token
    if (!r.print_token || r.print_token !== token)
      return res.status(403).send('<h2>Lien invalide ou expiré. Connectez-vous au tableau de bord pour accéder à votre reçu.</h2>');
  } else {
    // Accès via JWT (tableau de bord)
    const bearer = req.headers.authorization?.split(' ')[1];
    if (!bearer) return res.status(401).json({ error: 'Non autorisé' });
    try {
      const payload = jwt.verify(bearer, JWT_SECRET);
      if (payload.role !== 'admin' && payload.role !== 'tresoriere' && payload.id !== r.user_id)
        return res.status(403).send('Accès refusé');
    } catch { return res.status(401).json({ error: 'Non autorisé' }); }
  }

  const html = `<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8"/>
<title>Reçu fiscal ${r.annee} — AHH</title>
<style>
  @page { size: letter; margin: 2cm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; background: #fff; }
  .receipt { max-width: 720px; margin: 0 auto; padding: 40px; border: 2px solid #1b5e20; border-radius: 12px; }
  .header { display: flex; align-items: center; gap: 20px; border-bottom: 3px solid #1b5e20; padding-bottom: 24px; margin-bottom: 28px; }
  .logo-block { flex-shrink: 0; }
  .logo-block img { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; }
  .org-name { font-size: 1.4rem; font-weight: 800; color: #1b5e20; }
  .org-sub { font-size: .85rem; color: #555; margin-top: 2px; }
  .org-addr { font-size: .78rem; color: #777; margin-top: 4px; }
  .receipt-title { text-align: center; margin-bottom: 28px; }
  .receipt-title h1 { font-size: 1.5rem; font-weight: 800; color: #1b5e20; letter-spacing: 1px; }
  .receipt-title .num { font-size: .9rem; color: #888; margin-top: 4px; }
  .section { background: #f0f7f0; border-radius: 8px; padding: 18px 20px; margin-bottom: 18px; }
  .section h2 { font-size: .75rem; font-weight: 700; color: #1b5e20; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; font-size: .9rem; padding: 4px 0; border-bottom: 1px dashed #d0e8d0; }
  .row:last-child { border: none; }
  .row .label { color: #555; }
  .row .val { font-weight: 600; }
  .total-box { background: #1b5e20; color: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
  .total-box .tl { font-size: .9rem; opacity: .85; }
  .total-box .tv { font-size: 1.6rem; font-weight: 800; }
  .legal { font-size: .74rem; color: #777; line-height: 1.6; border-top: 1px solid #ddd; padding-top: 16px; margin-bottom: 20px; }
  .sig { display: flex; justify-content: space-between; align-items: flex-end; }
  .sig-line { border-top: 1px solid #333; width: 200px; padding-top: 6px; font-size: .8rem; color: #555; }
  .noprint { text-align: center; margin: 24px 0; }
  .noprint button { background: #1b5e20; color: #fff; border: none; padding: 12px 28px; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  @media print { .noprint { display: none; } body { margin: 0; } }
</style>
</head><body>
<div class="noprint"><button onclick="window.print()">🖨️ Imprimer / Sauvegarder en PDF</button></div>
<div class="receipt">
  <div class="header">
    <div class="logo-block"><img src="/Public/logo1.png" alt="AHH"/></div>
    <div>
      <div class="org-name">Association Haïtienne de Hamilton</div>
      <div class="org-sub">No. d'enregistrement : AHH-Hamilton-ON</div>
      <div class="org-addr">231 Fernwood Crescent, Hamilton, ON  L8T 3L7<br/>
        Tél : 905-818-8269 &nbsp;|&nbsp; info@ahhamilton.ca</div>
    </div>
  </div>

  <div class="receipt-title">
    <h1>REÇU FISCAL ${r.annee}</h1>
    <div class="num">Reçu n° AHH-${String(r.id).padStart(5,'0')} &nbsp;·&nbsp; Émis le ${new Date(r.date_generation||Date.now()).toLocaleDateString('fr-CA')}</div>
  </div>

  <div class="section">
    <h2>Remis à</h2>
    <div class="row"><span class="label">Nom complet</span><span class="val">${r.prenom} ${r.nom}</span></div>
    <div class="row"><span class="label">Courriel</span><span class="val">${r.email}</span></div>
    ${r.adresse ? `<div class="row"><span class="label">Adresse</span><span class="val">${r.adresse}</span></div>` : ''}
    ${r.telephone ? `<div class="row"><span class="label">Téléphone</span><span class="val">${r.telephone}</span></div>` : ''}
  </div>

  <div class="section">
    <h2>Contributions — Année fiscale ${r.annee}</h2>
    <div class="row"><span class="label">Cotisations et dons approuvés</span><span class="val">$${Number(r.montant_total).toFixed(2)} CAD</span></div>
  </div>

  <div class="total-box">
    <span class="tl">Total des contributions admissibles</span>
    <span class="tv">$${Number(r.montant_total).toFixed(2)} CAD</span>
  </div>

  <div class="legal">
    Ce reçu confirme que <strong>${r.prenom} ${r.nom}</strong> a contribué le montant indiqué ci-dessus à l'Association Haïtienne de Hamilton au cours de l'année fiscale <strong>${r.annee}</strong>.
    Ce reçu est émis conformément aux exigences de l'Agence du revenu du Canada (ARC).
    Veuillez conserver ce document pour votre déclaration de revenus.
  </div>

  <div class="sig">
    <div>
      <div class="sig-line">${r.gen_prenom || ''} ${r.gen_nom || ''}<br/>Représentant autorisé, AHH</div>
    </div>
    <div>
      <div class="sig-line">Date d'émission : ${new Date(r.date_generation||Date.now()).toLocaleDateString('fr-CA')}</div>
    </div>
  </div>
</div>
</body></html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ══════════════════════════════════════════════════════════════════════════════
// JOB MENSUEL : rappels paiement (15 du mois) + déclassement après 2 rappels
// ══════════════════════════════════════════════════════════════════════════════

function runPaymentReminderJob() {
  const now = new Date();
  if (now.getDate() !== 15) return; // Seulement le 15 du mois

  const currentMonth = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  console.log(`💳 Job rappels paiement — ${currentMonth}`);

  // Membres bienfaiteur/partenaire qui n'ont pas payé ce mois
  const debtors = db.prepare(`
    SELECT * FROM users
    WHERE role = 'member' AND actif = 1
    AND plan IN ('bienfaiteur','partenaire')
    AND (plan_paid_month IS NULL OR plan_paid_month < ?)
  `).all(currentMonth);

  debtors.forEach(u => {
    const montantDu = PLAN_PRIX[u.plan] || 10;
    const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id || 1;

    const unpaidCount = (u.plan_unpaid_count || 0) + 1;
    db.prepare('UPDATE users SET plan_unpaid_count=? WHERE id=?').run(unpaidCount, u.id);

    if (unpaidCount >= 3) {
      // Après 2 rappels (3e mois impayé) → déclasser en gratuit
      db.prepare("UPDATE users SET plan='gratuit', plan_unpaid_count=0 WHERE id=?").run(u.id);

      // Retirer toutes ses publications
      db.prepare("UPDATE talents SET statut='retire', actif=0 WHERE user_id=? AND statut='approuve'").run(u.id);
      db.prepare("UPDATE annonces SET statut='retire', actif=0 WHERE user_id=? AND statut='approuve'").run(u.id);

      // Notifier le membre
      const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
        .run(adminId, `⚠️ Votre plan a été rétrogradé en Gratuit`,
          `Bonjour ${u.prenom},\n\nSuite à ${unpaidCount-1} rappels de paiement sans réponse, votre plan ${u.plan} a été rétrogradé en plan Gratuit.\n\nVos publications (talents et annonces) ont été retirées.\n\nPour réactiver votre plan, déclarez votre paiement dans votre espace membre ou contactez l'administration.`);
      db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, u.id);
      createAlert(u.id, 'paiement', '⚠️ Plan rétrogradé en Gratuit', 'Paiements en retard — publications retirées.');

      // Notifier les admins
      const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','tresoriere') AND actif=1").all();
      admins.forEach(a => createAlert(a.id, 'paiement', `⚠️ ${u.prenom} ${u.nom} rétrogradé → Gratuit`, `Après ${unpaidCount-1} rappels impayés`));

      console.log(`⚠️ ${u.prenom} ${u.nom} rétrogradé → gratuit (${unpaidCount-1} rappels)`);
    } else {
      // Envoyer rappel
      const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
        .run(adminId, `Rappel paiement — Plan ${u.plan} — ${currentMonth}`,
          `Bonjour ${u.prenom},\n\nRappel (${unpaidCount}/2) : votre mensualité de $${montantDu}/mois est due.`);
      db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, u.id);
      createAlert(u.id, 'paiement', `Rappel paiement ${unpaidCount}/2 — $${montantDu} dû`, `Plan ${u.plan} — ${currentMonth}`);
      // Courriel réel
      mailer.sendRappelPaiement(u, montantDu, currentMonth).catch(()=>{});
      console.log(`💳 Rappel ${unpaidCount}/2 envoyé à ${u.prenom} ${u.nom}`);
    }
  });
}

// Job quotidien (vérifie le 15 chaque jour)
setInterval(runPaymentReminderJob, 24 * 60 * 60 * 1000);

// GET public — fiches talents approuvées
app.get('/api/talents', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.prenom, u.nom, u.email
    FROM talents t JOIN users u ON u.id = t.user_id
    WHERE t.actif = 1 AND (t.statut = 'approuve' OR t.statut IS NULL)
    ORDER BY t.categorie, t.nom
  `).all();
  res.json(rows);
});

// GET membre — ses propres fiches talents + quota détaillé
app.get('/api/mon-talent', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT * FROM talents WHERE user_id = ? ORDER BY date_creation DESC`).all(req.user.id);
  const u    = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
  const plan = u ? u.plan || 'gratuit' : 'gratuit';
  const rule = (PLAN_RULES[plan] || {}).talents || { perMonth:0, max:0 };
  const active = rows.filter(r => r.statut !== 'retire').length;
  const now   = new Date();
  const yStr  = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const monthly = db.prepare(`SELECT COUNT(*) AS n FROM talents WHERE user_id = ? AND substr(date_creation,1,7) = ?`).get(req.user.id, yStr).n;
  res.json({ items: rows, quota: {
    plan, totalUsed: active, totalMax: rule.max,
    monthUsed: monthly, monthMax: rule.perMonth,
    canCreate: active < rule.max && monthly < rule.perMonth && rule.max > 0
  }});
});

// GET admin — toutes les fiches (actives et inactives)
app.get('/api/talents/all', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.prenom, u.nom, u.email, u.plan
    FROM talents t JOIN users u ON u.id = t.user_id
    ORDER BY t.categorie, t.nom
  `).all();
  res.json(rows);
});

// POST — créer une fiche talent (admin = approuvé direct, membre = en_attente)
app.post('/api/talents', authMiddleware, uploadTalent.single('photo'), (req, res) => {
  const { nom, categorie, specialite, description, telephone, adresse, site_web, user_id } = req.body;
  const targetUserId = parseInt(user_id) || req.user.id;

  if (!can_admin(req) && !isPlanOk(targetUserId))
    return res.status(403).json({ error: 'Plan bienfaiteur ($10/mois) requis pour s\'afficher dans les talents.' });
  if (!can_admin(req)) {
    const lim = checkLimit(targetUserId, 'talents', 'talents');
    if (!lim.ok) return res.status(403).json({ error: lim.msg });
  }
  if (!nom || !categorie) return res.status(400).json({ error: 'Nom et catégorie requis' });

  const statut = can_admin(req) ? 'approuve' : 'en_attente';
  const photo_path = req.file ? `/uploads/talents/${req.file.filename}` : null;
  const r = db.prepare(`INSERT INTO talents (user_id, nom, categorie, specialite, description, telephone, adresse, site_web, photo_path, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(targetUserId, nom, categorie, specialite||'', description||'', telephone||'', adresse||'', site_web||'', photo_path, statut);

  // Notifier les admins si soumis par un membre
  if (!can_admin(req)) {
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif = 1").all();
    const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(req.user.id, `📋 Nouvelle fiche talent à valider — ${nom}`,
        `${req.user.prenom} ${req.user.nom} a soumis une fiche talent.\n\nNom : ${nom}\nCatégorie : ${categorie}\nSpécialité : ${specialite||'–'}\n\nConnectez-vous au dashboard → Nos talents pour approuver ou rejeter.`);
    const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)');
    admins.forEach(a => { ins.run(msgR.lastInsertRowid, a.id); createAlert(a.id,'talent',`Fiche talent à valider : ${nom}`,`Soumise par ${req.user.prenom} ${req.user.nom}`,r.lastInsertRowid); });
  }
  res.status(201).json({ id: r.lastInsertRowid, statut });
});

// PATCH — approuver / rejeter un talent
app.patch('/api/talents/:id/statut', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { statut, message_rejet } = req.body;
  if (!['approuve','rejete'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const talent = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!talent) return res.status(404).json({ error: 'Fiche introuvable' });
  db.prepare('UPDATE talents SET statut = ?, actif = ? WHERE id = ?')
    .run(statut, statut === 'approuve' ? 1 : 0, req.params.id);
  // Notifier le membre
  if (talent.user_id) {
    const msg = statut === 'approuve'
      ? `✅ Votre fiche talent "${talent.nom}" a été approuvée et est maintenant visible sur la page Talents.`
      : `❌ Votre fiche talent "${talent.nom}" n'a pas été approuvée.\n\n${message_rejet || 'Veuillez contacter l\'administration pour plus d\'informations.'}`;
    const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(req.user.id, statut === 'approuve' ? '✅ Fiche talent approuvée' : '❌ Fiche talent non approuvée', msg);
    db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(r.lastInsertRowid, talent.user_id);
    createAlert(talent.user_id, 'talent', statut === 'approuve' ? '✅ Fiche approuvée' : '❌ Fiche non approuvée', msg);
  }
  res.json({ message: 'Statut mis à jour' });
});

// PUT — modifier une fiche talent
app.put('/api/talents/:id', authMiddleware, uploadTalent.single('photo'), (req, res) => {
  const { nom, categorie, specialite, description, telephone, adresse, site_web, actif } = req.body;
  const talent = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!talent) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!can_admin(req) && talent.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });

  const photo_path = req.file ? `/uploads/talents/${req.file.filename}` : talent.photo_path;
  db.prepare(`UPDATE talents SET nom=?, categorie=?, specialite=?, description=?, telephone=?, adresse=?, site_web=?, photo_path=?, actif=? WHERE id=?`)
    .run(nom||talent.nom, categorie||talent.categorie, specialite||talent.specialite, description||talent.description,
        telephone||talent.telephone, adresse||talent.adresse, site_web||talent.site_web, photo_path,
        actif !== undefined ? actif : talent.actif, req.params.id);
  res.json({ message: 'Fiche mise à jour' });
});

// DELETE — supprimer une fiche talent
app.delete('/api/talents/:id', authMiddleware, (req, res) => {
  const talent = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!talent) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!can_admin(req) && talent.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM talents WHERE id = ?').run(req.params.id);
  if (talent.photo_path) {
    const p = path.join(__dirname, talent.photo_path);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ message: 'Fiche supprimée' });
});

function can_admin(req) { return ['admin','secretaire'].includes(req.user.role); }

// ── RETRAIT talent (questionnaire membre) ─────────────────────────────────
app.patch('/api/talents/:id/retirer', authMiddleware, (req, res) => {
  const { satisfait, raison } = req.body;
  const t = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!can_admin(req) && t.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });

  db.prepare(`UPDATE talents SET statut='retire', actif=0, retrait_satisfait=?, retrait_raison=? WHERE id=?`)
    .run(satisfait !== undefined ? (satisfait ? 1 : 0) : null, raison || '', req.params.id);

  // Notifier les admins
  const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif=1").all();
  const contenu = `La fiche talent « ${t.nom} » a été retirée par ${req.user.prenom} ${req.user.nom}.\n\nSatisfait du service : ${satisfait ? 'Oui' : 'Non'}\nRaison : ${raison || '–'}`;
  const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `📤 Fiche talent retirée : ${t.nom}`, contenu);
  admins.forEach(a => db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(r.lastInsertRowid, a.id));

  res.json({ message: 'Fiche retirée' });
});

// ── MODIFICATION talent (retour en_attente) ───────────────────────────────
app.put('/api/talents/:id/modifier', authMiddleware, uploadTalent.single('photo'), (req, res) => {
  const { nom, categorie, specialite, description, telephone, adresse, site_web } = req.body;
  const t = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!can_admin(req) && t.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });

  const photo_path = req.file ? `/uploads/talents/${req.file.filename}` : t.photo_path;
  // Remet notif_renouv à 0 pour futurs renouvellements
  db.prepare(`UPDATE talents SET nom=?,categorie=?,specialite=?,description=?,telephone=?,adresse=?,site_web=?,photo_path=?,statut='en_attente',actif=0,notif_renouv=0 WHERE id=?`)
    .run(nom||t.nom, categorie||t.categorie, specialite||t.specialite, description||t.description,
         telephone||t.telephone, adresse||t.adresse, site_web||t.site_web, photo_path, req.params.id);

  // Notifier les admins
  const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif=1").all();
  const rMsg = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `✏️ Fiche talent modifiée — validation requise : ${nom||t.nom}`,
      `${req.user.prenom} ${req.user.nom} a modifié sa fiche talent « ${nom||t.nom} ». Veuillez la valider dans le dashboard.`);
  admins.forEach(a => {
    db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(rMsg.lastInsertRowid, a.id);
    createAlert(a.id, 'talent', `✏️ Fiche modifiée à valider : ${nom||t.nom}`, `Modifiée par ${req.user.prenom} ${req.user.nom}`);
  });
  res.json({ message: 'Modification soumise pour validation' });
});

// ── RETRAIT annonce (questionnaire membre) ────────────────────────────────
app.patch('/api/annonces/:id/retirer', authMiddleware, (req, res) => {
  const { vendu, raison } = req.body;
  const a = db.prepare('SELECT * FROM annonces WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Annonce introuvable' });
  if (!can_admin(req) && a.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });

  db.prepare(`UPDATE annonces SET statut='retire', actif=0, retrait_vendu=?, retrait_raison=? WHERE id=?`)
    .run(vendu !== undefined ? (vendu ? 1 : 0) : null, raison || '', req.params.id);

  const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif=1").all();
  const contenu = `L'annonce « ${a.titre} » a été retirée par ${req.user.prenom} ${req.user.nom}.\n\nVendu/donné grâce au site : ${vendu ? 'Oui ✅' : 'Non ❌'}\nRaison : ${raison || '–'}`;
  const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `📤 Annonce retirée : ${a.titre}`, contenu);
  admins.forEach(adm => db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(r.lastInsertRowid, adm.id));

  res.json({ message: 'Annonce retirée' });
});

app.use('/uploads/talents', express.static(path.join(__dirname, 'uploads', 'talents')));

// ══════════════════════════════════════════════════════════════════════════════
// PETITES ANNONCES
// ══════════════════════════════════════════════════════════════════════════════

const annonceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'annonces');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadAnnonce = multer({ storage: annonceStorage, limits: { fileSize: 8 * 1024 * 1024 } });

// GET public — annonces approuvées
app.get('/api/annonces', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.prenom, u.nom,
      (SELECT GROUP_CONCAT(photo_path,'|') FROM annonce_photos WHERE annonce_id = a.id ORDER BY ordre) AS photos_raw
    FROM annonces a JOIN users u ON u.id = a.user_id
    WHERE a.actif = 1 AND (a.statut = 'approuve' OR a.statut IS NULL)
    ORDER BY a.date_creation DESC
  `).all();
  rows.forEach(r => { r.photos = r.photos_raw ? r.photos_raw.split('|') : []; delete r.photos_raw; });
  res.json(rows);
});

// GET membre — ses propres annonces + quota
app.get('/api/mes-annonces', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT GROUP_CONCAT(photo_path,'|') FROM annonce_photos WHERE annonce_id = a.id ORDER BY ordre) AS photos_raw
    FROM annonces a WHERE a.user_id = ? ORDER BY a.date_creation DESC
  `).all(req.user.id);
  rows.forEach(r => { r.photos = r.photos_raw ? r.photos_raw.split('|') : []; delete r.photos_raw; });
  const u    = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
  const plan = u ? u.plan || 'gratuit' : 'gratuit';
  const rule = (PLAN_RULES[plan] || {}).annonces || { perMonth:0, max:0 };
  const active = rows.filter(r => r.statut !== 'retire').length;
  const now   = new Date();
  const yStr  = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const monthly = db.prepare(`SELECT COUNT(*) AS n FROM annonces WHERE user_id = ? AND substr(date_creation,1,7) = ?`).get(req.user.id, yStr).n;
  res.json({ items: rows, quota: {
    plan, totalUsed: active, totalMax: rule.max,
    monthUsed: monthly, monthMax: rule.perMonth,
    canCreate: active < rule.max && monthly < rule.perMonth && rule.max > 0
  }});
});

// GET admin — toutes les annonces
app.get('/api/annonces/all', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.prenom, u.nom, u.plan,
      (SELECT GROUP_CONCAT(photo_path,'|') FROM annonce_photos WHERE annonce_id = a.id ORDER BY ordre) AS photos_raw
    FROM annonces a JOIN users u ON u.id = a.user_id
    ORDER BY a.date_creation DESC
  `).all();
  rows.forEach(r => { r.photos = r.photos_raw ? r.photos_raw.split('|') : []; delete r.photos_raw; });
  res.json(rows);
});

// POST — créer une annonce (admin = approuvé, membre = en_attente)
app.post('/api/annonces', authMiddleware, uploadAnnonce.array('photos', 5), (req, res) => {
  const { titre, description, prix, gratuit, type, categorie, telephone } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  if (!can_admin(req) && !isPlanOk(req.user.id))
    return res.status(403).json({ error: 'Plan bienfaiteur ($10/mois) requis pour publier une annonce.' });
  if (!can_admin(req)) {
    const lim = checkLimit(req.user.id, 'annonces', 'annonces');
    if (!lim.ok) return res.status(403).json({ error: lim.msg });
  }

  const statut = can_admin(req) ? 'approuve' : 'en_attente';
  const r = db.prepare(`INSERT INTO annonces (user_id, titre, description, prix, gratuit, type, categorie, telephone, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, titre, description||'', parseFloat(prix)||null, gratuit==='1'?1:0,
         type||'vente', categorie||'general', telephone||'', statut);

  const annonceId = r.lastInsertRowid;
  if (req.files && req.files.length) {
    const ins = db.prepare('INSERT INTO annonce_photos (annonce_id, photo_path, ordre) VALUES (?, ?, ?)');
    req.files.forEach((f, i) => ins.run(annonceId, `/uploads/annonces/${f.filename}`, i));
  }

  // Notifier les admins si soumis par un membre
  if (!can_admin(req)) {
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','secretaire') AND actif = 1").all();
    const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(req.user.id, `📌 Nouvelle annonce à valider — ${titre}`,
        `${req.user.prenom} ${req.user.nom} a soumis une annonce.\n\nTitre : ${titre}\nType : ${type}\nPrix : ${gratuit==='1'?'Gratuit':(prix?'$'+prix:'À discuter')}\n\nConnectez-vous au dashboard → Petites annonces pour approuver ou rejeter.`);
    const ins2 = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)');
    admins.forEach(a => { ins2.run(msgR.lastInsertRowid, a.id); createAlert(a.id,'annonce',`Annonce à valider : ${titre}`,`Soumise par ${req.user.prenom} ${req.user.nom}`,annonceId); });
  }
  res.status(201).json({ id: annonceId, statut });
});

// PATCH — approuver / rejeter une annonce
app.patch('/api/annonces/:id/statut', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { statut, message_rejet } = req.body;
  if (!['approuve','rejete'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const ann = db.prepare('SELECT * FROM annonces WHERE id = ?').get(req.params.id);
  if (!ann) return res.status(404).json({ error: 'Annonce introuvable' });
  db.prepare('UPDATE annonces SET statut = ?, actif = ? WHERE id = ?')
    .run(statut, statut === 'approuve' ? 1 : 0, req.params.id);
  if (ann.user_id) {
    const msg = statut === 'approuve'
      ? `✅ Votre annonce "${ann.titre}" a été approuvée et est maintenant visible sur la page Annonces.`
      : `❌ Votre annonce "${ann.titre}" n'a pas été approuvée.\n\n${message_rejet || 'Veuillez contacter l\'administration.'}`;
    const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(req.user.id, statut === 'approuve' ? '✅ Annonce approuvée' : '❌ Annonce non approuvée', msg);
    db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(r.lastInsertRowid, ann.user_id);
    createAlert(ann.user_id, 'annonce', statut === 'approuve' ? '✅ Annonce approuvée' : '❌ Annonce non approuvée', msg);
  }
  res.json({ message: 'Statut mis à jour' });
});

// PUT — modifier une annonce
app.put('/api/annonces/:id', authMiddleware, (req, res) => {
  const { titre, description, prix, gratuit, type, categorie, telephone, actif } = req.body;
  const ann = db.prepare('SELECT * FROM annonces WHERE id = ?').get(req.params.id);
  if (!ann) return res.status(404).json({ error: 'Annonce introuvable' });
  if (!can_admin(req) && ann.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  db.prepare(`UPDATE annonces SET titre=?, description=?, prix=?, gratuit=?, type=?, categorie=?, telephone=?, actif=? WHERE id=?`)
    .run(titre||ann.titre, description||ann.description, prix!==undefined?parseFloat(prix)||null:ann.prix,
         gratuit!==undefined?(gratuit==='1'||gratuit===1?1:0):ann.gratuit,
         type||ann.type, categorie||ann.categorie, telephone||ann.telephone,
         actif!==undefined?actif:ann.actif, req.params.id);
  res.json({ message: 'Annonce mise à jour' });
});

// DELETE — supprimer une annonce
app.delete('/api/annonces/:id', authMiddleware, (req, res) => {
  const ann = db.prepare('SELECT * FROM annonces WHERE id = ?').get(req.params.id);
  if (!ann) return res.status(404).json({ error: 'Annonce introuvable' });
  if (!can_admin(req) && ann.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  const photos = db.prepare('SELECT photo_path FROM annonce_photos WHERE annonce_id = ?').all(req.params.id);
  photos.forEach(p => { const fp = path.join(__dirname, p.photo_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
  db.prepare('DELETE FROM annonces WHERE id = ?').run(req.params.id);
  res.json({ message: 'Annonce supprimée' });
});

// PATCH plan utilisateur
app.patch('/api/users/:id/plan', authMiddleware, requireRole('admin','secretaire','delegue','tresoriere'), (req, res) => {
  const { plan } = req.body;
  if (!['gratuit','bienfaiteur','partenaire'].includes(plan))
    return res.status(400).json({ error: 'Plan invalide' });
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, req.params.id);
  res.json({ message: 'Plan mis à jour' });
});

app.use('/uploads/annonces', express.static(path.join(__dirname, 'uploads', 'annonces')));

// ══════════════════════════════════════════════════════════════════════════════
// QR CODE ACTIVITÉ
// ══════════════════════════════════════════════════════════════════════════════

// Génère le QR code — route PUBLIQUE — ?format=png&size=800 pour haute résolution
app.get('/api/activities/:id/qr', async (req, res) => {
  const act = db.prepare('SELECT id, titre, qr_token FROM activities WHERE id = ?').get(req.params.id);
  if (!act || !act.qr_token) return res.status(404).send('QR non disponible');

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url     = `${baseUrl}/activity-checkout.html?actid=${act.id}&token=${act.qr_token}`;
  const format  = req.query.format === 'png' ? 'png' : 'svg';
  const size    = Math.min(Math.max(parseInt(req.query.size) || (format === 'png' ? 800 : 300), 200), 2000);

  try {
    if (format === 'png') {
      // Générer le QR avec niveau H (30% correction) pour permettre le logo
      const qrBuf = await QRCode.toBuffer(url, {
        type: 'png', width: size, margin: 2,
        errorCorrectionLevel: 'H',
        color: { dark: '#1b5e20', light: '#ffffff' }
      });

      // Superposer le logo au centre
      const logoPath = path.join(__dirname, 'Public', 'logo1.png');
      let finalBuf = qrBuf;
      if (fs.existsSync(logoPath)) {
        const qrImg   = await jimp.Jimp.read(qrBuf);
        const logoImg = await jimp.Jimp.read(logoPath);
        const logoSize = Math.round(qrImg.bitmap.width * 0.22);
        const pad      = Math.round(logoSize * 0.15);
        const bg = new jimp.Jimp({ width: logoSize + pad * 2, height: logoSize + pad * 2, color: 0xFFFFFFFF });
        logoImg.resize({ w: logoSize, h: logoSize });
        bg.composite(logoImg, pad, pad);
        const cx = Math.round((qrImg.bitmap.width  - bg.bitmap.width)  / 2);
        const cy = Math.round((qrImg.bitmap.height - bg.bitmap.height) / 2);
        qrImg.composite(bg, cx, cy);
        finalBuf = await qrImg.getBuffer('image/png');
      }

      const filename = `QR-${act.titre.replace(/[^a-zA-Z0-9]/g,'-').substring(0,30)}.png`;
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.set('Cache-Control', 'no-cache');
      return res.send(finalBuf);
    }

    // SVG avec logo centré
    const svgRaw = await QRCode.toString(url, {
      type: 'svg', width: size, margin: 2,
      color: { dark: '#1b5e20', light: '#ffffff' }
    });
    const vbMatch = svgRaw.match(/viewBox="0 0 (\d+) (\d+)"/);
    const vbSize  = vbMatch ? parseInt(vbMatch[1]) : 37;

    let svgFinal = svgRaw;
    const logoPath = path.join(__dirname, 'Public', 'logo1.png');
    if (fs.existsSync(logoPath)) {
      const logo64   = fs.readFileSync(logoPath).toString('base64');
      const logoSize = Math.round(vbSize * 0.22);
      const pad      = Math.round(vbSize * 0.035);
      const x        = Math.round((vbSize - logoSize) / 2);
      const y        = Math.round((vbSize - logoSize) / 2);
      svgFinal = svgRaw
        .replace('<svg ', '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ')
        .replace('</svg>',
          `<rect x="${x-pad}" y="${y-pad}" width="${logoSize+pad*2}" height="${logoSize+pad*2}" rx="${pad}" fill="white"/>` +
          `<image href="data:image/png;base64,${logo64}" xlink:href="data:image/png;base64,${logo64}" ` +
            `x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>` +
          `</svg>`);
    }
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-cache');
    res.send(svgFinal);
  } catch(e) {
    console.error('QR error:', e.message);
    res.status(500).send('Erreur QR');
  }
});

// Retourne les infos de l'activité pour la page de checkout QR
app.get('/api/activities/:id/checkout', async (req, res) => {
  const { token } = req.query;
  const act = db.prepare('SELECT * FROM activities WHERE id = ? AND qr_token = ?').get(req.params.id, token);
  if (!act) return res.status(404).json({ error: 'QR invalide' });
  res.json({
    id: act.id, titre: act.titre, date_debut: act.date_debut,
    lieu: act.lieu, prix: act.prix, paiement_requis: act.paiement_requis
  });
});

// POST — payer l'activité via QR (authentifié ou anonymous avec token)
app.post('/api/activities/:id/pay', authMiddleware, (req, res) => {
  const { qr_token, methode, reference } = req.body;
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  if (act.qr_token !== qr_token) return res.status(403).json({ error: 'Token QR invalide' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  let montant = act.prix || 0;

  // Appliquer le rabais selon le plan
  try {
    const rabais = JSON.parse(act.rabais_json || '{}');
    if (rabais[user.plan]) {
      const r = rabais[user.plan];
      if (r.type === '%') montant = montant * (1 - r.val / 100);
      else if (r.type === '$') montant = Math.max(0, montant - r.val);
    }
  } catch {}

  // Enregistrer ou mettre à jour l'inscription + paiement
  const existing = db.prepare('SELECT * FROM activity_registrations WHERE activity_id=? AND user_id=?').get(act.id, user.id);
  if (existing) {
    db.prepare('UPDATE activity_registrations SET paye=1, montant_paye=?, statut=?, date_paiement=CURRENT_TIMESTAMP WHERE id=?')
      .run(montant, 'inscrit', existing.id);
  } else {
    db.prepare('INSERT INTO activity_registrations (activity_id, user_id, statut, paye, montant_paye, date_paiement) VALUES (?,?,?,1,?,CURRENT_TIMESTAMP)')
      .run(act.id, user.id, 'inscrit', montant);
  }

  // Créer un billet avec QR "Acheté en ligne" et assigner une table libre
  const existingTicket = db.prepare("SELECT id FROM tickets WHERE activity_id=? AND user_id=? AND statut='actif'").get(act.id, user.id);
  if (!existingTicket) {
    const freeTable = db.prepare(`
      SELECT at.* FROM activity_tables at
      WHERE at.activity_id = ? AND at.membre_attribue IS NULL
        AND (SELECT COUNT(*) FROM tickets t WHERE t.table_id = at.id AND t.statut = 'actif') < at.capacite_max
      ORDER BY at.numero LIMIT 1
    `).get(act.id);
    const qrText = `Acheté en ligne\n${freeTable ? 'Table ' + freeTable.numero : 'Aucune table'}\n${act.titre}`;
    db.prepare(`INSERT INTO tickets (activity_id, table_id, user_id, acheteur_nom, acheteur_email, qr_data, prix, methode_paiement)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(act.id, freeTable?.id || null, user.id, `${user.prenom} ${user.nom}`, user.email, qrText, montant, methode || 'qr');
  }

  // Message de confirmation au membre
  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id || 1;
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(adminId,
      `✅ Paiement confirmé — ${act.titre}`,
      `Bonjour ${user.prenom},\n\nVotre paiement pour l'activité « ${act.titre} » a été enregistré.\n\nMontant : $${montant.toFixed(2)}\nDate de l'activité : ${act.date_debut}\nLieu : ${act.lieu||'–'}\n\nVotre billet est disponible dans votre espace membre.\n\nMerci de votre participation !`);
  db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, user.id);
  createAlert(user.id, 'activite', `✅ Paiement confirmé : ${act.titre}`, `$${montant.toFixed(2)}`);

  // Notifier la finance
  const finance = db.prepare("SELECT id FROM users WHERE role IN ('admin','tresoriere') AND actif=1").all();
  const finMsg = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(adminId, `💳 Paiement activité : ${act.titre} — ${user.prenom} ${user.nom}`,
      `${user.prenom} ${user.nom} a payé $${montant.toFixed(2)} pour l'activité « ${act.titre} ».\n\nPlan: ${user.plan}\nMéthode: ${methode||'QR'}\nRéf: ${reference||'–'}`);
  const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)');
  finance.forEach(f => ins.run(finMsg.lastInsertRowid, f.id));

  res.json({ message: 'Paiement enregistré', montant });
});

// POST — valider présence via QR sans connexion (email seulement) + auto-login
app.post('/api/activities/:id/scan-public', (req, res) => {
  const { qr_token, email } = req.body;
  if (!qr_token || !email) return res.status(400).json({ error: 'Token et email requis' });
  const act = db.prepare('SELECT * FROM activities WHERE id = ? AND qr_token = ?').get(req.params.id, qr_token);
  if (!act) return res.status(403).json({ error: 'QR invalide' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND actif = 1').get(email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'Aucun membre trouvé avec cet email. Contactez un administrateur.' });

  const existing = db.prepare('SELECT * FROM activity_registrations WHERE activity_id=? AND user_id=?').get(act.id, user.id);
  if (existing) {
    db.prepare("UPDATE activity_registrations SET statut='present' WHERE id=?").run(existing.id);
  } else {
    db.prepare("INSERT INTO activity_registrations (activity_id, user_id, statut) VALUES (?,?,'present')").run(act.id, user.id);
  }

  // Générer un JWT pour connecter automatiquement le membre
  const { password_hash, ...safeUser } = user;
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({
    token, user: safeUser,
    activite: act.titre, paiement_requis: act.paiement_requis, prix: act.prix
  });
});

// POST — payer activité via Stripe (redirige vers Stripe Checkout)
app.post('/api/activities/:id/pay-stripe', authMiddleware, async (req, res) => {
  const { qr_token } = req.body;
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  if (act.qr_token !== qr_token) return res.status(403).json({ error: 'Token QR invalide' });

  const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey) return res.status(500).json({ error: 'Paiement en ligne non configuré — payez sur place.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
  try {
    const stripe = Stripe(stripeKey);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: user.email,
      line_items: [{
        price_data: {
          currency: 'cad',
          product_data: { name: act.titre, description: act.lieu || '' },
          unit_amount: Math.round((act.prix || 0) * 100),
        },
        quantity: 1,
      }],
      metadata: { type: 'activite', activity_id: String(act.id), user_id: String(user.id), qr_token },
      success_url: `${siteBase}/carte.html?id=${user.id}&checkin=${encodeURIComponent(act.titre)}&paid=1`,
      cancel_url: `${siteBase}/activity-checkout.html?actid=${act.id}&token=${qr_token}`,
    });
    res.json({ checkout_url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST — valider présence via QR (scan)
app.post('/api/activities/:id/scan', authMiddleware, (req, res) => {
  const { qr_token } = req.body;
  const act = db.prepare('SELECT * FROM activities WHERE id = ? AND qr_token = ?').get(req.params.id, qr_token);
  if (!act) return res.status(403).json({ error: 'QR invalide' });

  const existing = db.prepare('SELECT * FROM activity_registrations WHERE activity_id=? AND user_id=?').get(act.id, req.user.id);
  if (existing) {
    db.prepare("UPDATE activity_registrations SET statut='present' WHERE id=?").run(existing.id);
  } else {
    db.prepare("INSERT INTO activity_registrations (activity_id, user_id, statut) VALUES (?,?,'present')").run(act.id, req.user.id);
  }
  res.json({ message: 'Présence validée', activite: act.titre });
});

// GET — inscrits d'une activité avec statut paiement
app.get('/api/activities/:id/inscrits', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const rows = db.prepare(`
    SELECT ar.*, u.prenom, u.nom, u.email, u.plan
    FROM activity_registrations ar JOIN users u ON u.id = ar.user_id
    WHERE ar.activity_id = ? ORDER BY ar.date_inscription
  `).all(req.params.id);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// TABLES & BILLETS (système de places)
// ══════════════════════════════════════════════════════════════════════════════

// Configurer N tables pour une activité
app.post('/api/activities/:id/tables/setup', authMiddleware, requireRole('admin','delegue','secretaire'), (req, res) => {
  const { nb_tables, capacite_max = 10 } = req.body;
  if (!nb_tables || nb_tables < 1) return res.status(400).json({ error: 'Nombre de tables requis' });
  const actId = parseInt(req.params.id);
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM activity_tables WHERE activity_id = ?').get(actId);
  for (let i = existing.cnt + 1; i <= nb_tables; i++) {
    try { db.prepare('INSERT INTO activity_tables (activity_id, numero, capacite_max) VALUES (?, ?, ?)').run(actId, i, capacite_max); } catch {}
  }
  res.json({ message: `Tables 1–${nb_tables} configurées` });
});

// Lister les tables d'une activité avec occupancy
app.get('/api/activities/:id/tables', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT at.*, u.prenom || ' ' || u.nom AS membre_nom,
      (SELECT COUNT(*) FROM tickets t WHERE t.table_id = at.id AND t.statut = 'actif') AS places_vendues
    FROM activity_tables at
    LEFT JOIN users u ON u.id = at.membre_attribue
    WHERE at.activity_id = ?
    ORDER BY at.numero
  `).all(req.params.id);
  res.json(rows);
});

// Assigner/désassigner une table à un membre comité
app.put('/api/activity-tables/:id/assign', authMiddleware, requireRole('admin'), (req, res) => {
  const { membre_id } = req.body;
  db.prepare('UPDATE activity_tables SET membre_attribue = ? WHERE id = ?').run(membre_id || null, req.params.id);
  res.json({ message: 'Table mise à jour' });
});

// Vente physique d'un ou plusieurs billets par un membre comité
app.post('/api/activities/:id/tickets/sell', authMiddleware, requireRole('admin','delegue','secretaire','tresoriere'), (req, res) => {
  const { acheteur_nom, acheteur_email, acheteur_telephone, prix, methode_paiement = 'cash', quantite = 1 } = req.body;
  if (!acheteur_nom) return res.status(400).json({ error: 'Nom de l\'acheteur requis' });
  const actId = parseInt(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  // Chercher la table réservée pour ce membre, sinon une table libre avec de la place
  let table = db.prepare(`
    SELECT at.*, (SELECT COUNT(*) FROM tickets t WHERE t.table_id = at.id AND t.statut = 'actif') AS places_vendues
    FROM activity_tables at WHERE at.activity_id = ? AND at.membre_attribue = ?
  `).get(actId, req.user.id);

  if (!table || table.places_vendues >= table.capacite_max) {
    table = db.prepare(`
      SELECT at.*, (SELECT COUNT(*) FROM tickets t WHERE t.table_id = at.id AND t.statut = 'actif') AS places_vendues
      FROM activity_tables at
      WHERE at.activity_id = ? AND at.membre_attribue IS NULL
        AND (SELECT COUNT(*) FROM tickets t WHERE t.table_id = at.id AND t.statut = 'actif') < at.capacite_max
      ORDER BY at.numero LIMIT 1
    `).get(actId);
  }
  if (!table) return res.status(400).json({ error: 'Aucune table disponible — ajoutez des tables d\'abord' });

  const vendeur = db.prepare('SELECT prenom, nom FROM users WHERE id = ?').get(req.user.id);
  const prixUnit = parseFloat(prix) || act.prix || 0;
  const qrData = `Vendu par ${vendeur.prenom} ${vendeur.nom}\nTable ${table.numero}\n${act.titre}`;

  const r = db.prepare(`INSERT INTO tickets (activity_id, table_id, acheteur_nom, acheteur_email, acheteur_telephone, vendu_par, qr_data, prix, methode_paiement, quantite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(actId, table.id, acheteur_nom, acheteur_email || '', acheteur_telephone || '', req.user.id, qrData, prixUnit, methode_paiement, parseInt(quantite));

  // Enregistrer le revenu dans la ligne financière
  if (prixUnit > 0) {
    const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id = ? LIMIT 1').get(actId);
    if (line) {
      db.prepare(`INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par)
        VALUES (?, 'revenu', ?, ?, ?, ?)`)
        .run(line.id, prixUnit * parseInt(quantite), `Vente billet: ${acheteur_nom}`, methode_paiement, req.user.id);
      db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(prixUnit * parseInt(quantite));
    }
  }

  res.status(201).json({ id: r.lastInsertRowid, qr_data: qrData, table_numero: table.numero });
});

// Tous les billets d'une activité (comité)
app.get('/api/activities/:id/tickets', authMiddleware, requireRole('admin','delegue','secretaire','tresoriere'), (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, at.numero AS table_numero, at.capacite_max,
      u.prenom || ' ' || u.nom AS vendeur_nom
    FROM tickets t
    LEFT JOIN activity_tables at ON at.id = t.table_id
    LEFT JOIN users u ON u.id = t.vendu_par
    WHERE t.activity_id = ?
    ORDER BY at.numero, t.date_vente
  `).all(req.params.id);
  res.json(rows);
});

// Mes billets (membre connecté)
app.get('/api/tickets/my', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, a.titre AS activite, a.date_debut, a.lieu,
      at.numero AS table_numero, u.prenom || ' ' || u.nom AS vendeur_nom
    FROM tickets t
    JOIN activities a ON a.id = t.activity_id
    LEFT JOIN activity_tables at ON at.id = t.table_id
    LEFT JOIN users u ON u.id = t.vendu_par
    WHERE t.user_id = ? AND t.statut = 'actif'
    ORDER BY a.date_debut DESC
  `).all(req.user.id);
  res.json(rows);
});

// QR code d'un billet (route publique avec token)
app.get('/api/tickets/:id/qr', async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).send('Billet introuvable');
  try {
    const svgRaw = await QRCode.toString(ticket.qr_data || String(ticket.id), {
      type: 'svg', width: 260, margin: 2,
      color: { dark: '#1b5e20', light: '#ffffff' }
    });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-cache');
    res.send(svgRaw);
  } catch(e) { res.status(500).send('Erreur QR'); }
});

// Présents en direct pour une activité
app.get('/api/activities/:id/live', authMiddleware, requireRole('admin','delegue','secretaire','tresoriere'), (req, res) => {
  const actId = parseInt(req.params.id);
  const act = db.prepare('SELECT id, titre, date_debut, lieu, max_participants FROM activities WHERE id = ?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  const tickets = db.prepare(`
    SELECT t.id, t.acheteur_nom, t.acheteur_email, t.prix, t.checked_in, t.date_checkin, t.statut,
      at.numero AS table_numero,
      v.prenom || ' ' || v.nom AS vendeur_nom,
      u.prenom AS buyer_prenom, u.nom AS buyer_nom
    FROM tickets t
    LEFT JOIN activity_tables at ON at.id = t.table_id
    LEFT JOIN users v ON v.id = t.vendu_par
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.activity_id = ? AND t.statut = 'actif'
    ORDER BY t.date_checkin DESC, t.date_vente ASC
  `).all(actId);

  // Inscriptions sans billet (activités non-payantes)
  const registrations = db.prepare(`
    SELECT ar.user_id, ar.date_inscription, ar.checked_in, ar.date_checkin,
      u.prenom, u.nom, u.email, u.plan
    FROM activity_registrations ar
    JOIN users u ON u.id = ar.user_id
    WHERE ar.activity_id = ?
    ORDER BY ar.date_checkin DESC, ar.date_inscription ASC
  `).all(actId);

  const nbTickets     = tickets.length;
  const nbPresents    = tickets.filter(t => t.checked_in).length;
  const nbAbsents     = nbTickets - nbPresents;
  const totalRevenu   = tickets.reduce((s, t) => s + (t.prix || 0), 0);
  const nbReg         = registrations.length;
  const nbRegPresents = registrations.filter(r => r.checked_in).length;

  res.json({
    activite: act,
    stats: { nbTickets, nbPresents, nbAbsents, totalRevenu, nbReg, nbRegPresents },
    presents: tickets.filter(t => t.checked_in).map(t => ({
      id: t.id, type: 'ticket',
      nom: t.acheteur_nom || `${t.buyer_prenom||''} ${t.buyer_nom||''}`.trim(),
      email: t.acheteur_email,
      table: t.table_numero,
      prix: t.prix,
      heure: t.date_checkin,
      vendeur: t.vendeur_nom
    })),
    attente: tickets.filter(t => !t.checked_in).map(t => ({
      id: t.id, type: 'ticket',
      nom: t.acheteur_nom || `${t.buyer_prenom||''} ${t.buyer_nom||''}`.trim(),
      email: t.acheteur_email,
      table: t.table_numero,
      prix: t.prix,
      vendeur: t.vendeur_nom
    })),
    inscrits: registrations.map(r => ({
      id: r.user_id, type: 'inscription',
      nom: `${r.prenom} ${r.nom}`, email: r.email, plan: r.plan,
      checked_in: r.checked_in, heure: r.date_checkin
    }))
  });
});

// Check-in : scanner un QR billet et marquer l'entrée
app.post('/api/tickets/checkin', authMiddleware, requireRole('admin','delegue','secretaire','tresoriere'), (req, res) => {
  const { qr_data, activity_id } = req.body;
  console.log(`[CHECKIN] user=${req.user.id} qr="${qr_data}" act=${activity_id||'all'}`);
  if (!qr_data) return res.status(400).json({ error: 'QR data manquant' });

  // Chercher d'abord sans filtre statut (pour diagnostiquer)
  const ticket = db.prepare(`
    SELECT t.*, a.titre AS activite, a.id AS act_id,
      at.numero AS table_numero,
      v.prenom || ' ' || v.nom AS vendeur_nom,
      b.prenom AS buyer_prenom, b.nom AS buyer_nom
    FROM tickets t
    LEFT JOIN activities a ON a.id = t.activity_id
    LEFT JOIN activity_tables at ON at.id = t.table_id
    LEFT JOIN users v ON v.id = t.vendu_par
    LEFT JOIN users b ON b.id = t.user_id
    WHERE (t.qr_data = ? OR t.barcode_data = ?)
  `).get(qr_data, qr_data);

  console.log(`[CHECKIN] ticket trouvé: ${ticket ? `id=${ticket.id} statut=${ticket.statut} payment=${ticket.payment_status}` : 'AUCUN'}`);
  if (!ticket) return res.status(404).json({ error: 'Billet introuvable — QR non reconnu' });

  // Vérifier statut : accepter actif OU payment_status=paid
  const isValid = ticket.statut === 'actif' || ticket.payment_status === 'paid';
  if (!isValid) {
    return res.status(403).json({ error: `Billet ${ticket.statut === 'annule' ? 'annulé' : 'non activé'} (statut: ${ticket.statut})` });
  }
  if (activity_id && ticket.act_id !== parseInt(activity_id)) {
    return res.status(409).json({ error: `Ce billet est pour l'activité : ${ticket.activite}` });
  }

  const alreadyIn = ticket.checked_in === 1;
  if (!alreadyIn) {
    db.prepare('UPDATE tickets SET checked_in=1, date_checkin=CURRENT_TIMESTAMP WHERE id=?').run(ticket.id);
  }

  res.json({
    ok: true,
    already_checked_in: alreadyIn,
    nom: ticket.acheteur_nom || ((ticket.buyer_prenom||'') + ' ' + (ticket.buyer_nom||'')).trim(),
    table_numero: ticket.table_numero,
    activite: ticket.activite,
    vendeur_nom: ticket.vendeur_nom,
    vendu_en_ligne: !ticket.vendu_par,
    prix: ticket.prix,
    date_checkin: alreadyIn ? ticket.date_checkin : new Date().toISOString()
  });
});

// Rapport ventes par membre comité pour une activité
app.get('/api/activities/:id/tickets/report', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const act = db.prepare('SELECT titre FROM activities WHERE id = ?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Introuvable' });
  const byMembre = db.prepare(`
    SELECT u.prenom || ' ' || u.nom AS vendeur, u.id AS vendeur_id,
      COUNT(t.id) AS nb_billets, SUM(t.prix * t.quantite) AS total_ventes,
      GROUP_CONCAT(at.numero) AS tables_utilisees
    FROM tickets t
    LEFT JOIN users u ON u.id = t.vendu_par
    LEFT JOIN activity_tables at ON at.id = t.table_id
    WHERE t.activity_id = ? AND t.statut = 'actif'
    GROUP BY t.vendu_par
    ORDER BY nb_billets DESC
  `).all(req.params.id);
  const online = db.prepare(`SELECT COUNT(*) AS cnt, SUM(prix*quantite) AS total FROM tickets WHERE activity_id = ? AND vendu_par IS NULL AND statut = 'actif'`).get(req.params.id);
  res.json({ activite: act.titre, par_membre: byMembre, en_ligne: online });
});

// ══════════════════════════════════════════════════════════════════════════════
// RAPPORTS AVANCÉS
// ══════════════════════════════════════════════════════════════════════════════

const REPORT_ROLES = ['admin','tresoriere','secretaire','delegue'];

// Rapport activité : inscrits membres + billets + check-in
app.get('/api/reports/activity/:id', authMiddleware, requireRole(...REPORT_ROLES), (req, res) => {
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  // Membres inscrits
  const inscrits = db.prepare(`
    SELECT ar.*, u.prenom, u.nom, u.email, u.plan
    FROM activity_registrations ar JOIN users u ON u.id = ar.user_id
    WHERE ar.activity_id = ? ORDER BY u.nom
  `).all(req.params.id);

  // Billets vendus (en ligne + en personne)
  const billets = db.prepare(`
    SELECT t.*, att.nom AS type_nom
    FROM tickets t
    LEFT JOIN activity_ticket_types att ON att.id = t.ticket_type_id
    WHERE t.activity_id = ? AND t.payment_status = 'paid'
    ORDER BY t.id
  `).all(req.params.id);

  // Stats check-in
  const arrivés = billets.filter(b => b.checked_in === 1).length;
  const nonArrivés = billets.filter(b => b.checked_in !== 1).length;

  // Par type de billet
  const parType = {};
  for (const b of billets) {
    const k = b.type_nom || 'Entrée générale';
    if (!parType[k]) parType[k] = { nb: 0, montant: 0, arrives: 0 };
    parType[k].nb++;
    parType[k].montant += b.prix || 0;
    if (b.checked_in === 1) parType[k].arrives++;
  }

  const revenuBillets = billets.reduce((s, b) => s + (b.prix || 0), 0);
  const revenuMembres = inscrits.filter(r => r.paye).reduce((s, r) => s + (r.montant_paye || 0), 0);

  res.json({
    activite: act,
    inscrits,
    billets,
    parType,
    checkin: { arrives: arrivés, non_arrives: nonArrivés, total: billets.length },
    totalRevenu: revenuBillets + revenuMembres,
    nbPayes: inscrits.filter(r => r.paye).length + billets.length,
    nbNonPayes: inscrits.filter(r => !r.paye).length
  });
});

// Rapport global activités (toutes ou par période)
app.get('/api/reports/activities', authMiddleware, requireRole(...REPORT_ROLES), (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT a.*, COUNT(ar.id) AS nb_inscrits,
    SUM(CASE WHEN ar.paye=1 THEN ar.montant_paye ELSE 0 END) AS revenu
    FROM activities a LEFT JOIN activity_registrations ar ON ar.activity_id = a.id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND a.date_debut >= ?'; params.push(from); }
  if (to)   { sql += ' AND a.date_debut <= ?'; params.push(to); }
  sql += ' GROUP BY a.id ORDER BY a.date_debut DESC';
  res.json(db.prepare(sql).all(...params));
});

// Rapport membres plans mensuel (payés / non payés)
app.get('/api/reports/plans', authMiddleware, requireRole(...REPORT_ROLES), (req, res) => {
  const { mois } = req.query;
  const currentMonth = mois || new Date().toISOString().substring(0,7);
  const membres = db.prepare(`
    SELECT u.id, u.prenom, u.nom, u.email, u.plan, u.plan_unpaid_count, u.plan_paid_month,
      (SELECT COUNT(*) FROM payments WHERE user_id = u.id AND statut='approuve' AND mois = ?) AS paye_mois
    FROM users u WHERE u.role = 'member' AND u.actif = 1 ORDER BY u.plan, u.nom
  `).all(currentMonth);
  res.json({ mois: currentMonth, membres });
});

// Liste de tous les membres
app.get('/api/reports/membres', authMiddleware, requireRole(...REPORT_ROLES), (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, COUNT(ar.id) AS nb_activites,
      SUM(CASE WHEN ar.paye=1 THEN ar.montant_paye ELSE 0 END) AS total_paye_activites
    FROM users u LEFT JOIN activity_registrations ar ON ar.user_id = u.id
    WHERE u.actif = 1 AND (u.phantom IS NULL OR u.phantom = 0) GROUP BY u.id ORDER BY u.role, u.nom
  `).all();
  res.json(rows.map(u => { const {password_hash,...safe}=u; return safe; }));
});

// ── Debug temporaire : voir tous les paiements (à supprimer après test) ───
app.get('/api/debug/payments', (req, res) => {
  const rows = db.prepare('SELECT * FROM payments ORDER BY date_soumission DESC LIMIT 20').all();
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// TÉMOIGNAGES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/testimonials', (req, res) => {
  res.json(db.prepare('SELECT * FROM testimonials WHERE actif=1 ORDER BY ordre, id').all());
});
app.post('/api/testimonials', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { prenom, nom, description, texte, ordre } = req.body;
  if (!prenom || !texte) return res.status(400).json({ error: 'Prénom et texte requis' });
  const r = db.prepare('INSERT INTO testimonials (prenom, nom, description, texte, ordre) VALUES (?,?,?,?,?)')
    .run(prenom, nom||'', description||'', texte, ordre||0);
  res.status(201).json({ id: r.lastInsertRowid });
});
app.put('/api/testimonials/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { prenom, nom, description, texte, actif, ordre } = req.body;
  db.prepare('UPDATE testimonials SET prenom=?, nom=?, description=?, texte=?, actif=?, ordre=? WHERE id=?')
    .run(prenom, nom||'', description||'', texte, actif??1, ordre??0, req.params.id);
  res.json({ message: 'Mis à jour' });
});
app.delete('/api/testimonials/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id=?').run(req.params.id);
  res.json({ message: 'Supprimé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// VIDÉOS
// ══════════════════════════════════════════════════════════════════════════════
function extractYoutubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&\s?]+)/);
  return m ? m[1] : null;
}
app.get('/api/videos', (req, res) => {
  res.json(db.prepare('SELECT * FROM videos WHERE actif=1 ORDER BY date_creation DESC').all());
});
app.post('/api/videos', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { titre, description, youtube_url } = req.body;
  if (!titre || !youtube_url) return res.status(400).json({ error: 'Titre et URL YouTube requis' });
  if (!extractYoutubeId(youtube_url)) return res.status(400).json({ error: 'URL YouTube invalide' });
  const r = db.prepare('INSERT INTO videos (titre, description, youtube_url) VALUES (?,?,?)')
    .run(titre, description||'', youtube_url);
  res.status(201).json({ id: r.lastInsertRowid });
});
app.put('/api/videos/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { titre, description, youtube_url, actif } = req.body;
  db.prepare('UPDATE videos SET titre=?, description=?, youtube_url=?, actif=? WHERE id=?')
    .run(titre, description||'', youtube_url, actif??1, req.params.id);
  res.json({ message: 'Mis à jour' });
});
app.delete('/api/videos/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('DELETE FROM videos WHERE id=?').run(req.params.id);
  res.json({ message: 'Supprimé' });
});

// ══ TYPES DE BILLETS ══════════════════════════════════════════════════════════

// Public: infos activité + types de billets (sans auth)
app.get('/api/activities/:id/public', (req, res) => {
  const act = db.prepare(`SELECT id, titre, date_debut, date_fin, lieu, description, paiement_requis, prix
    FROM activities WHERE id = ? AND statut NOT IN ('archivee','brouillon')`).get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  let types = db.prepare('SELECT * FROM activity_ticket_types WHERE activity_id = ? AND actif = 1 ORDER BY ordre, id').all(req.params.id);
  // Si l'activité a un prix mais aucun type de billet → générer une "Entrée générale" automatique
  if (!types.length && act.paiement_requis && act.prix > 0) {
    types = [{ id: 'general', activity_id: act.id, nom: 'Entrée générale', description: '', prix: act.prix, capacite_max: 0, nb_vendus: 0, actif: 1, ordre: 0 }];
  }
  res.json({ ...act, ticket_types: types });
});

// Public: liste des types de billets
app.get('/api/activities/:id/ticket-types', (req, res) => {
  const types = db.prepare('SELECT * FROM activity_ticket_types WHERE activity_id = ? AND actif = 1 ORDER BY ordre, id').all(req.params.id);
  res.json(types);
});

// Admin: créer un type de billet
app.post('/api/activities/:id/ticket-types', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const { nom, description, prix, capacite_max, ordre } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare('INSERT INTO activity_ticket_types (activity_id, nom, description, prix, capacite_max, ordre) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, nom, description || '', parseFloat(prix) || 0, parseInt(capacite_max) || 0, parseInt(ordre) || 0);
  res.status(201).json({ id: r.lastInsertRowid });
});

// Admin: modifier un type de billet
app.put('/api/activities/ticket-types/:id', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const { nom, description, prix, capacite_max, ordre, actif } = req.body;
  db.prepare('UPDATE activity_ticket_types SET nom=?, description=?, prix=?, capacite_max=?, ordre=?, actif=? WHERE id=?')
    .run(nom, description || '', parseFloat(prix) || 0, parseInt(capacite_max) || 0, parseInt(ordre) || 0, actif === false ? 0 : 1, req.params.id);
  res.json({ ok: true });
});

// Admin: supprimer un type de billet (seulement si aucun billet vendu)
app.delete('/api/activities/ticket-types/:id', authMiddleware, requireRole('admin', 'secretaire'), (req, res) => {
  const tt = db.prepare('SELECT nb_vendus FROM activity_ticket_types WHERE id=?').get(req.params.id);
  if (!tt) return res.status(404).json({ error: 'Introuvable' });
  if (tt.nb_vendus > 0) return res.status(400).json({ error: 'Des billets ont été vendus — désactivez plutôt ce type.' });
  db.prepare('DELETE FROM activity_ticket_types WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Public: acheter des billets en ligne (Interac ou Stripe)
app.post('/api/activities/:id/buy', async (req, res) => {
  const actId = parseInt(req.params.id);
  const { prenom, nom, email, telephone, items, payment_method } = req.body;
  if (!prenom || !nom || !email) return res.status(400).json({ error: 'Prénom, nom et courriel requis' });
  if (!items || !items.length) return res.status(400).json({ error: 'Aucun billet sélectionné' });

  const act = db.prepare('SELECT * FROM activities WHERE id=?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  // Valider types et calculer total
  let montantTotal = 0;
  const lineItems = [];
  for (const item of items) {
    const qty = parseInt(item.quantity) || 0;
    if (qty < 1) continue;
    let tt;
    if (String(item.ticket_type_id) === 'general') {
      // Billet générique automatique basé sur le prix de l'activité
      tt = { id: null, activity_id: actId, nom: 'Entrée générale', prix: act.prix || 0, capacite_max: 0, nb_vendus: 0 };
    } else {
      tt = db.prepare('SELECT * FROM activity_ticket_types WHERE id=? AND activity_id=? AND actif=1').get(item.ticket_type_id, actId);
      if (!tt) return res.status(400).json({ error: 'Type de billet invalide' });
      if (tt.capacite_max > 0 && tt.nb_vendus + qty > tt.capacite_max) {
        return res.status(400).json({ error: `Plus assez de places pour "${tt.nom}"` });
      }
    }
    montantTotal += tt.prix * qty;
    lineItems.push({ tt, qty });
  }
  if (!lineItems.length) return res.status(400).json({ error: 'Aucun billet sélectionné' });

  const orderToken = require('crypto').randomUUID();
  const acheteurNom = `${prenom} ${nom}`;
  const paymentStatus = montantTotal === 0 ? 'paid' : 'pending';
  const ticketStatut = paymentStatus === 'paid' ? 'actif' : 'en_attente';

  // Créer les billets
  const insertedTickets = [];
  for (const { tt, qty } of lineItems) {
    for (let i = 0; i < qty; i++) {
      const ticketToken = require('crypto').randomUUID();
      let barcode = newBarcodeData();
      while (db.prepare('SELECT id FROM tickets WHERE barcode_data = ?').get(barcode)) barcode = newBarcodeData();
      const r = db.prepare(`INSERT INTO tickets
        (activity_id, ticket_type_id, acheteur_nom, acheteur_email, acheteur_telephone,
         qr_data, barcode_data, prix, methode_paiement, payment_status, order_token, statut)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(actId, tt.id, acheteurNom, email, telephone || '',
          `TICKET:${ticketToken}`, barcode, tt.prix, payment_method || 'interac',
          paymentStatus, orderToken, ticketStatut);
      if (tt.id) db.prepare('UPDATE activity_ticket_types SET nb_vendus = nb_vendus + 1 WHERE id=?').run(tt.id);
      insertedTickets.push({ id: r.lastInsertRowid, token: ticketToken, barcode, nom: tt.nom, prix: tt.prix });
    }
  }

  if (montantTotal === 0) {
    // Billets gratuits → envoyer QR immédiatement
    try {
      for (const t of insertedTickets) {
        const qrUrl = `${process.env.SITE_URL || 'https://ahhamilton.ca'}/scan.html?t=${t.token}`;
        const qrBuf = await QRCode.toBuffer(qrUrl, { type: 'png', width: 300, margin: 2 });
        mailer.sendBilletQR(email, prenom, act, t, qrBuf.toString('base64')).catch(() => {});
      }
    } catch (e) { console.error('QR gratuit:', e.message); }
    return res.json({ order_token: orderToken, statut: 'paid' });
  }

  if (payment_method === 'stripe') {
    const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!stripeKey) {
      // Rollback
      insertedTickets.forEach(t => db.prepare('DELETE FROM tickets WHERE id=?').run(t.id));
      lineItems.forEach(({ tt, qty }) => { if (tt.id) db.prepare('UPDATE activity_ticket_types SET nb_vendus = nb_vendus - ? WHERE id=?').run(qty, tt.id); });
      return res.status(500).json({ error: 'Paiement Stripe non configuré — utilisez Interac.' });
    }
    try {
      const stripe = Stripe(stripeKey);
      const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        customer_email: email,
        line_items: lineItems.map(({ tt, qty }) => ({
          price_data: {
            currency: 'cad',
            product_data: { name: `${tt.nom} — ${act.titre}` },
            unit_amount: Math.round(tt.prix * 100),
          },
          quantity: qty,
        })),
        metadata: { type: 'billet', order_token: orderToken, activity_id: String(actId), acheteur_email: email, acheteur_prenom: prenom },
        success_url: `${siteBase}/billets.html?order=${orderToken}&success=1`,
        cancel_url: `${siteBase}/billets.html?id=${actId}&cancelled=1`,
      });
      return res.json({ checkout_url: session.url, order_token: orderToken });
    } catch (err) {
      insertedTickets.forEach(t => db.prepare('DELETE FROM tickets WHERE id=?').run(t.id));
      lineItems.forEach(({ tt, qty }) => { if (tt.id) db.prepare('UPDATE activity_ticket_types SET nb_vendus = nb_vendus - ? WHERE id=?').run(qty, tt.id); });
      return res.status(500).json({ error: err.message });
    }
  }

  // Interac : envoyer instructions par courriel
  const interacEmail = process.env.INTERAC_EMAIL || process.env.SMTP_USER || 'tresoriere@ahhamilton.ca';
  const orderRef = `BILLET-${orderToken.substring(0, 8).toUpperCase()}`;
  mailer.sendBilletInterac(email, prenom, act, insertedTickets, orderRef, interacEmail, montantTotal).catch(() => {});
  mailer.sendNouvelleCommandeBillet(act, acheteurNom, email, montantTotal, insertedTickets, orderRef).catch(() => {});
  res.json({ order_token: orderToken, interac: { email: interacEmail, montant: montantTotal, reference: orderRef } });
});

// Public: activer les billets après retour Stripe (order_token = UUID impossible à deviner)
app.post('/api/orders/:orderToken/activate', async (req, res) => {
  const { orderToken } = req.params;
  // UUID format check (basic security)
  if (!orderToken || !/^[0-9a-f-]{32,}$/i.test(orderToken)) return res.status(400).json({ error: 'Token invalide' });

  const tickets = db.prepare('SELECT * FROM tickets WHERE order_token = ?').all(orderToken);
  if (!tickets.length) return res.status(404).json({ error: 'Commande introuvable' });

  const email  = tickets[0].acheteur_email || '';
  const prenom = (tickets[0].acheteur_nom || '').split(' ')[0];
  const act    = db.prepare('SELECT * FROM activities WHERE id=?').get(tickets[0].activity_id);
  const forceResend = req.query.resend === '1';

  // Déjà activé → renvoyer le QR seulement si ?resend=1
  if (tickets[0].payment_status === 'paid' && !forceResend) {
    return res.json({ ok: true, email, already: true, hint: 'Ajoutez ?resend=1 pour renvoyer le QR' });
  }

  try {
    // Activer tous les billets de cette commande
    db.prepare("UPDATE tickets SET statut='actif', payment_status='paid' WHERE order_token=?").run(orderToken);
    const activated = db.prepare('SELECT * FROM tickets WHERE order_token=?').all(orderToken);

    // Envoyer QR par courriel (URL publique sur le serveur)
    const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
    const qrDir = path.join(__dirname, 'uploads', 'qr');
    if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
    for (const t of activated) {
      const ticketToken = (t.qr_data || '').replace('TICKET:', '');
      try {
        const scanUrl = `${siteBase}/scan.html?t=${ticketToken}`;
        const qrBuf = await QRCode.toBuffer(scanUrl, { type: 'png', width: 500, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#1b5e20', light: '#ffffff' } });
        const qrFile = path.join(qrDir, `${ticketToken}.png`);
        fs.writeFileSync(qrFile, qrBuf);
        const qrPublicUrl = `${siteBase}/uploads/qr/${ticketToken}.png`;
        const nomBillet = t.ticket_type_id ? (db.prepare('SELECT nom FROM activity_ticket_types WHERE id=?').get(t.ticket_type_id)?.nom || 'Entrée générale') : 'Entrée générale';
        console.log(`📧 Envoi QR à ${t.acheteur_email} — URL: ${qrPublicUrl}`);
        mailer.sendBilletQR(t.acheteur_email, prenom, act, { ...t, nom: nomBillet, token: ticketToken }, qrBuf.toString('base64'), qrPublicUrl).catch(e => console.error('QR mail error:', e.message));
      } catch(e) { console.error('QR gen error:', e.message); }
    }

    // Inscrire dans activity_registrations si c'est un membre connu
    const membre = email ? db.prepare('SELECT id FROM users WHERE email = ? AND actif = 1').get(email) : null;
    if (membre && act) {
      const existing = db.prepare('SELECT id FROM activity_registrations WHERE activity_id=? AND user_id=?').get(act.id, membre.id);
      if (!existing) db.prepare("INSERT INTO activity_registrations (activity_id, user_id, statut) VALUES (?,?,'inscrit')").run(act.id, membre.id);
    }

    // Enregistrer le revenu dans les finances
    const montant = activated.reduce((s, t) => s + (t.prix || 0), 0);
    if (montant > 0 && act) {
      const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id=? LIMIT 1').get(act.id);
      if (line) {
        const adminId = db.prepare("SELECT id FROM users WHERE role='admin' AND (phantom IS NULL OR phantom=0) LIMIT 1").get()?.id || 1;
        const alreadyTx = db.prepare("SELECT id FROM transactions WHERE description LIKE ? AND financial_line_id=?").get(`%${orderToken.substring(0,8)}%`, line.id);
        if (!alreadyTx) {
          db.prepare("INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par) VALUES (?, 'revenu', ?, ?, 'stripe', ?)")
            .run(line.id, montant, `Stripe billet ${orderToken.substring(0,8)} — ${email}`, adminId);
          db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(montant);
        }
      }
    }

    console.log(`✅ Billets activés (retour Stripe): ${email} — ${activated.length} billet(s) — $${montant}`);
    res.json({ ok: true, email, nb_billets: activated.length });
  } catch(e) {
    console.error('Activate order error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: liste des commandes en attente (doit être avant /:orderToken)
app.get('/api/orders/pending', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
  const orders = db.prepare(`
    SELECT t.order_token, t.acheteur_nom, t.acheteur_email, t.methode_paiement, t.payment_status,
      a.titre AS activite, a.id AS activity_id,
      COUNT(t.id) AS nb_billets, SUM(t.prix) AS montant_total, MIN(t.date_vente) AS date_commande
    FROM tickets t
    JOIN activities a ON a.id = t.activity_id
    WHERE t.payment_status = 'pending' AND t.order_token IS NOT NULL
    GROUP BY t.order_token
    ORDER BY date_commande DESC
  `).all();
  res.json(orders);
});

// Public: voir l'état d'une commande
app.get('/api/orders/:orderToken', (req, res) => {
  const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
  const tickets = db.prepare(`
    SELECT t.*, att.nom AS type_nom, a.titre AS activite, a.date_debut, a.lieu
    FROM tickets t
    JOIN activities a ON a.id = t.activity_id
    LEFT JOIN activity_ticket_types att ON att.id = t.ticket_type_id
    WHERE t.order_token = ?
    ORDER BY t.id
  `).all(req.params.orderToken);
  if (!tickets.length) return res.status(404).json({ error: 'Commande introuvable' });
  const ticketsWithQR = tickets.map(t => {
    const token = (t.qr_data || '').replace('TICKET:', '');
    const qrPath = path.join(__dirname, 'uploads', 'qr', `${token}.png`);
    return { ...t, qr_file_url: fs.existsSync(qrPath) ? `${siteBase}/uploads/qr/${token}.png` : null };
  });
  res.json({ tickets: ticketsWithQR, statut: tickets[0].payment_status });
});

// Admin: confirmer paiement Interac → activer billets + envoyer QR
app.post('/api/orders/:orderToken/confirm', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), async (req, res) => {
  const { orderToken } = req.params;
  const tickets = db.prepare('SELECT * FROM tickets WHERE order_token=? AND payment_status="pending"').all(orderToken);
  if (!tickets.length) return res.status(404).json({ error: 'Commande introuvable ou déjà confirmée' });

  db.prepare("UPDATE tickets SET statut='actif', payment_status='paid' WHERE order_token=?").run(orderToken);

  const act = db.prepare('SELECT * FROM activities WHERE id=?').get(tickets[0].activity_id);
  for (const t of tickets) {
    const ticketToken = (t.qr_data || '').replace('TICKET:', '');
    try {
      const qrUrl = `${process.env.SITE_URL || 'https://ahhamilton.ca'}/scan.html?t=${ticketToken}`;
      const qrBuf = await QRCode.toBuffer(qrUrl, { type: 'png', width: 300, margin: 2 });
      const typeNom = t.ticket_type_id ? (db.prepare('SELECT nom FROM activity_ticket_types WHERE id=?').get(t.ticket_type_id)?.nom || '') : '';
      mailer.sendBilletQR(t.acheteur_email, t.acheteur_nom.split(' ')[0], act, { ...t, nom: typeNom, token: ticketToken }, qrBuf.toString('base64')).catch(() => {});
    } catch (e) { console.error('QR confirm error:', e.message); }
  }

  // Enregistrer le revenu financier
  const montantTotal = tickets.reduce((s, t) => s + (t.prix || 0), 0);
  if (montantTotal > 0) {
    const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id=? LIMIT 1').get(tickets[0].activity_id);
    if (line) {
      db.prepare("INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par) VALUES (?, 'revenu', ?, ?, ?, ?)")
        .run(line.id, montantTotal, `Billets en ligne — ${tickets[0].acheteur_nom}`, 'interac', req.user.id);
      db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(montantTotal);
    }
  }

  res.json({ ok: true, nb: tickets.length });
});

// Admin: annuler une commande en attente
app.post('/api/orders/:orderToken/cancel', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
  const tickets = db.prepare('SELECT * FROM tickets WHERE order_token=?').all(req.params.orderToken);
  if (!tickets.length) return res.status(404).json({ error: 'Commande introuvable' });
  db.prepare('UPDATE tickets SET statut="annule", payment_status="cancelled" WHERE order_token=?').run(req.params.orderToken);
  tickets.forEach(t => {
    if (t.ticket_type_id) db.prepare('UPDATE activity_ticket_types SET nb_vendus = MAX(0, nb_vendus - 1) WHERE id=?').run(t.ticket_type_id);
  });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PROFIL PUBLIC MEMBRE
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/members/:id/public', (req, res) => {
  const user = db.prepare(`
    SELECT id, prenom, nom, role, bio, photo_url, date_inscription
    FROM users WHERE id = ? AND actif = 1
  `).get(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'Membre introuvable' });
  const talents = db.prepare(`
    SELECT nom, categorie, specialite, description, site_web, photo_path
    FROM talents WHERE user_id = ? AND statut = 'approuve' AND actif = 1
  `).all(user.id);
  res.json({ ...user, talents });
});

// ══════════════════════════════════════════════════════════════════════════════
// RAPPELS DE RENOUVELLEMENT D'ADHÉSION
// ══════════════════════════════════════════════════════════════════════════════

function checkRenewalReminders() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 11);
  const cutoffStr = cutoff.toISOString().slice(0, 7);
  const members = db.prepare(`
    SELECT id, prenom, nom, email, plan, plan_paid_month, telephone, operateur, sms_notifs FROM users
    WHERE actif = 1 AND role = 'member' AND plan != 'gratuit'
    AND (plan_paid_month IS NULL OR plan_paid_month <= ?)
  `).all(cutoffStr);
  members.forEach(member => {
    mailer.sendRappelAdhesion(member).catch(e => console.error('[RENEWAL] Email error:', e.message));
    mailer.sendSMS(member, `Rappel AHH : renouvelez votre adhésion ${member.plan} sur ahhamilton.ca`).catch(() => {});
    console.log(`[RENEWAL] Rappel envoyé → ${member.email}`);
  });
  if (members.length) console.log(`[RENEWAL] ${members.length} rappel(s) envoyé(s)`);
}

(function scheduleRenewalCheck() {
  const now = new Date();
  const next9am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
  if (now >= next9am) next9am.setDate(next9am.getDate() + 1);
  setTimeout(() => {
    checkRenewalReminders();
    setInterval(checkRenewalReminders, 24 * 60 * 60 * 1000);
  }, next9am - now);
  console.log(`[RENEWAL] Prochain rappel planifié à ${next9am.toLocaleTimeString('fr-CA')}`);
})();

// QR code générique (utilisé par carte.html et autres pages)
app.get('/api/qr', authMiddleware, async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ error: 'data requis' });
  const qr = await QRCode.toDataURL(data, { width: 200, margin: 1 });
  res.json({ qr });
});

// ══════════════════════════════════════════════════════════════════════════════
// FORUM
// ══════════════════════════════════════════════════════════════════════════════

const FORUM_CATEGORIES = ['general','entraide','emploi','logement','culture','annonces'];

app.get('/api/forum/topics', authMiddleware, (req, res) => {
  const topics = db.prepare(`
    SELECT ft.*, u.prenom, u.nom,
      (SELECT COUNT(*) FROM forum_posts WHERE topic_id = ft.id) AS nb_posts,
      (SELECT date_creation FROM forum_posts WHERE topic_id = ft.id ORDER BY date_creation DESC LIMIT 1) AS dernier_post
    FROM forum_topics ft LEFT JOIN users u ON u.id = ft.auteur_id
    ORDER BY ft.epingle DESC, ft.date_derniere_activite DESC
  `).all();
  res.json(topics);
});

app.post('/api/forum/topics', authMiddleware, (req, res) => {
  const { titre, categorie, contenu } = req.body;
  if (!titre?.trim() || !contenu?.trim()) return res.status(400).json({ error: 'Titre et contenu requis' });
  const cat = FORUM_CATEGORIES.includes(categorie) ? categorie : 'general';
  const topic = db.prepare(`INSERT INTO forum_topics (titre, categorie, auteur_id) VALUES (?,?,?)`).run(titre.trim(), cat, req.user.id);
  db.prepare(`INSERT INTO forum_posts (topic_id, auteur_id, contenu) VALUES (?,?,?)`).run(topic.lastInsertRowid, req.user.id, contenu.trim());
  res.json({ id: topic.lastInsertRowid });
});

app.get('/api/forum/topics/:id', authMiddleware, (req, res) => {
  const topic = db.prepare(`SELECT ft.*, u.prenom, u.nom FROM forum_topics ft LEFT JOIN users u ON u.id = ft.auteur_id WHERE ft.id=?`).get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Sujet introuvable' });
  db.prepare(`UPDATE forum_topics SET nb_vues = nb_vues + 1 WHERE id=?`).run(req.params.id);
  const posts = db.prepare(`SELECT fp.*, u.prenom, u.nom, u.photo_url FROM forum_posts fp LEFT JOIN users u ON u.id = fp.auteur_id WHERE fp.topic_id=? ORDER BY fp.date_creation ASC`).all(req.params.id);
  res.json({ topic, posts });
});

app.post('/api/forum/topics/:id/posts', authMiddleware, (req, res) => {
  const topic = db.prepare('SELECT * FROM forum_topics WHERE id=?').get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Sujet introuvable' });
  if (topic.ferme && !['admin','secretaire'].includes(req.user.role)) return res.status(403).json({ error: 'Sujet fermé' });
  const { contenu } = req.body;
  if (!contenu?.trim()) return res.status(400).json({ error: 'Contenu requis' });
  const post = db.prepare(`INSERT INTO forum_posts (topic_id, auteur_id, contenu) VALUES (?,?,?)`).run(req.params.id, req.user.id, contenu.trim());
  db.prepare(`UPDATE forum_topics SET date_derniere_activite=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
  res.json({ id: post.lastInsertRowid });
});

app.delete('/api/forum/topics/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('DELETE FROM forum_topics WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/forum/posts/:id', authMiddleware, (req, res) => {
  const post = db.prepare('SELECT * FROM forum_posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post introuvable' });
  if (post.auteur_id !== req.user.id && !['admin','secretaire'].includes(req.user.role)) return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM forum_posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/forum/topics/:id/pin', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare(`UPDATE forum_topics SET epingle = CASE WHEN epingle=1 THEN 0 ELSE 1 END WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/forum/topics/:id/close', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare(`UPDATE forum_topics SET ferme = CASE WHEN ferme=1 THEN 0 ELSE 1 END WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEWSLETTER
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/newsletter', authMiddleware, requireRole('admin','secretaire','tresoriere'), async (req, res) => {
  const { sujet, corps, segment } = req.body;
  if (!sujet?.trim() || !corps?.trim()) return res.status(400).json({ error: 'Sujet et corps requis' });

  let query = `SELECT id, prenom, nom, email, plan FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0)`;
  if (segment === 'bienfaiteur') query += ` AND plan='bienfaiteur'`;
  else if (segment === 'partenaire') query += ` AND plan='partenaire'`;
  else if (segment === 'payants') query += ` AND plan IN ('bienfaiteur','partenaire')`;
  const membres = db.prepare(query).all();
  if (!membres.length) return res.status(400).json({ error: 'Aucun destinataire dans ce segment' });

  const { sendMail } = require('./mailer');
  let ok = 0, errors = 0;
  for (const m of membres) {
    try {
      await sendMail({
        to: m.email,
        subject: sujet,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:auto">
          <p>Bonjour ${m.prenom},</p>
          ${corps.replace(/\n/g,'<br/>')}
          <hr style="margin:24px 0;border:none;border-top:1px solid #eee"/>
          <p style="font-size:.8rem;color:#888">Association Haïtienne de Hamilton · <a href="https://ahhamilton.ca">ahhamilton.ca</a></p>
        </div>`
      });
      ok++;
    } catch { errors++; }
  }

  db.prepare(`INSERT INTO newsletter_sends (expediteur_id, sujet, corps, nb_destinataires, segment) VALUES (?,?,?,?,?)`)
    .run(req.user.id, sujet, corps, ok, segment || 'tous');

  res.json({ ok, errors, total: membres.length });
});

app.get('/api/newsletter/history', authMiddleware, requireRole('admin','secretaire','tresoriere'), (req, res) => {
  const rows = db.prepare(`SELECT ns.*, u.prenom, u.nom FROM newsletter_sends ns LEFT JOIN users u ON u.id=ns.expediteur_id ORDER BY ns.date_envoi DESC LIMIT 50`).all();
  res.json(rows);
});

app.patch('/api/newsletter/:id', authMiddleware, requireRole('admin','secretaire','tresoriere'), (req, res) => {
  const { sujet, corps } = req.body;
  if (!sujet?.trim() || !corps?.trim()) return res.status(400).json({ error: 'Sujet et corps requis' });
  const row = db.prepare('SELECT * FROM newsletter_sends WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Introuvable' });
  if (req.user.role !== 'admin' && req.user.id !== row.expediteur_id) return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('UPDATE newsletter_sends SET sujet=?, corps=? WHERE id=?').run(sujet.trim(), corps.trim(), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/newsletter/:id', authMiddleware, requireRole('admin','secretaire','tresoriere'), (req, res) => {
  const row = db.prepare('SELECT * FROM newsletter_sends WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Introuvable' });
  if (req.user.role !== 'admin' && req.user.id !== row.expediteur_id) return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM newsletter_sends WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/newsletter/:id/archive', authMiddleware, requireRole('admin','secretaire','tresoriere'), (req, res) => {
  const row = db.prepare('SELECT * FROM newsletter_sends WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Introuvable' });
  if (req.user.role !== 'admin' && req.user.id !== row.expediteur_id) return res.status(403).json({ error: 'Accès refusé' });
  const newVal = row.archive ? 0 : 1;
  db.prepare('UPDATE newsletter_sends SET archive=? WHERE id=?').run(newVal, req.params.id);
  res.json({ ok: true, archive: !!newVal });
});

// ══════════════════════════════════════════════════════════════════════════════
// VENTE EN PERSONNE (cash, par membre comité)
// ══════════════════════════════════════════════════════════════════════════════

// GET tables réservées pour un membre comité sur une activité
app.get('/api/activities/:id/mes-tables', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const ct = db.prepare('SELECT * FROM comite_tables WHERE activity_id=? AND user_id=?').get(req.params.id, req.user.id);
  const act = db.prepare('SELECT id, titre, max_participants FROM activities WHERE id=?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  res.json({ tables: ct || null, activite: act });
});

// POST assigner des tables à un membre comité (admin seulement)
app.post('/api/activities/:id/assigner-tables', authMiddleware, requireRole('admin','tresoriere','secretaire'), (req, res) => {
  const { user_id, table_debut, table_fin } = req.body;
  if (!user_id || !table_debut || !table_fin) return res.status(400).json({ error: 'Champs requis' });
  db.prepare('INSERT OR REPLACE INTO comite_tables (activity_id, user_id, table_debut, table_fin) VALUES (?,?,?,?)')
    .run(req.params.id, user_id, table_debut, table_fin);
  res.json({ ok: true });
});

// POST vente en personne — mode 'generer' (sans revenue) ou 'vendre' (avec revenue)
app.post('/api/activities/:id/vendre', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), async (req, res) => {
  const { acheteur_nom, nb_billets = 1, prix_unitaire, mode = 'vendre' } = req.body;
  const actId = parseInt(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id=?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  const prix = parseFloat(prix_unitaire) || act.prix || 0;
  const vendeurId = req.user.id;
  const isGenerer = mode === 'generer'; // true = pré-imprimer sans enregistrer la vente
  const statut = isGenerer ? 'genere' : 'actif';
  const paymentStatus = isGenerer ? 'pending' : 'paid';
  const tickets = [];
  const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
  const qrDir = path.join(__dirname, 'uploads', 'qr');
  if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

  for (let i = 0; i < parseInt(nb_billets); i++) {
    const ticketToken = require('crypto').randomUUID();
    let barcode = newBarcodeData();
    while (db.prepare('SELECT id FROM tickets WHERE barcode_data = ?').get(barcode)) barcode = newBarcodeData();

    const r = db.prepare(`INSERT INTO tickets
      (activity_id, acheteur_nom, qr_data, barcode_data, prix, methode_paiement, payment_status, statut, vendu_par)
      VALUES (?,?,?,?,?,'cash',?,?,?)`)
      .run(actId, acheteur_nom || 'Anonyme', `TICKET:${ticketToken}`, barcode, prix, paymentStatus, statut, vendeurId);

    try {
      const scanUrl = `${siteBase}/scan.html?t=${ticketToken}`;
      const qrBuf = await QRCode.toBuffer(scanUrl, { type: 'png', width: 400, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#1b5e20', light: '#ffffff' } });
      fs.writeFileSync(path.join(qrDir, `${ticketToken}.png`), qrBuf);
    } catch(e) {}

    tickets.push({ id: r.lastInsertRowid, token: ticketToken, barcode, prix, acheteur_nom: acheteur_nom || 'Anonyme' });
  }

  // Enregistrer revenu seulement si vente réelle (pas génération)
  if (!isGenerer && prix > 0) {
    const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id=? LIMIT 1').get(actId);
    if (line) {
      const montantTotal = prix * parseInt(nb_billets);
      db.prepare("INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par) VALUES (?, 'revenu', ?, ?, 'cash', ?)")
        .run(line.id, montantTotal, `Billets cash — ${acheteur_nom || 'Anonyme'} × ${nb_billets}`, vendeurId);
      db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(montantTotal);
    }
  }

  res.json({ ok: true, mode, tickets });
});

// POST — marquer un billet généré comme vendu (enregistre le revenu)
app.post('/api/tickets/:id/marquer-vendu', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Billet introuvable' });
  if (t.statut !== 'genere') return res.status(400).json({ error: 'Ce billet n\'est pas en attente de vente' });

  db.prepare("UPDATE tickets SET statut='actif', payment_status='paid', methode_paiement='cash' WHERE id=?").run(t.id);

  // Enregistrer revenu
  if (t.prix > 0) {
    const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id=? LIMIT 1').get(t.activity_id);
    if (line) {
      const adminId = db.prepare("SELECT id FROM users WHERE role='admin' AND (phantom IS NULL OR phantom=0) LIMIT 1").get()?.id || 1;
      db.prepare("INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par) VALUES (?, 'revenu', ?, ?, 'cash', ?)")
        .run(line.id, t.prix, `Billet vendu — ${t.barcode_data}`, req.user.id);
      db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(t.prix);
    }
  }
  res.json({ ok: true, barcode: t.barcode_data });
});

// POST — marquer vendu par code-barres (saisie des talons)
app.post('/api/tickets/by-barcode/:code/marquer-vendu', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const t = db.prepare("SELECT * FROM tickets WHERE barcode_data = ? AND statut = 'genere'").get(req.params.code);
  if (!t) return res.status(404).json({ ok: false, error: 'Billet introuvable ou déjà vendu' });

  db.prepare("UPDATE tickets SET statut='actif', payment_status='paid' WHERE id=?").run(t.id);
  if (t.prix > 0) {
    const line = db.prepare('SELECT id FROM financial_lines WHERE activity_id=? LIMIT 1').get(t.activity_id);
    if (line) {
      db.prepare("INSERT INTO transactions (financial_line_id, type, montant, description, methode, cree_par) VALUES (?, 'revenu', ?, ?, 'cash', ?)")
        .run(line.id, t.prix, `Talon vendu — ${t.barcode_data}`, req.user.id);
      db.prepare('UPDATE account_info SET solde = solde + ?, date_maj = CURRENT_TIMESTAMP WHERE id = 1').run(t.prix);
    }
  }
  res.json({ ok: true, barcode: t.barcode_data, prix: t.prix });
});

// POST — annuler tous les billets générés non vendus d'une activité
app.post('/api/activities/:id/annuler-non-vendus', authMiddleware, requireRole('admin','tresoriere','secretaire'), (req, res) => {
  const r = db.prepare("UPDATE tickets SET statut='annule' WHERE activity_id=? AND statut='genere'").run(req.params.id);
  res.json({ ok: true, annules: r.changes });
});

// GET — billets générés (non encore vendus) d'une activité
app.get('/api/activities/:id/billets-generes', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const tickets = db.prepare("SELECT id, barcode_data, acheteur_nom, prix, vendu_par FROM tickets WHERE activity_id=? AND statut='genere' ORDER BY id").all(req.params.id);
  res.json(tickets);
});

// ── Vue publique d'un ticket (pour ticket.html) ───────────────────────────────
app.get('/api/tickets/:id/view', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, a.titre AS activite, a.date_debut, a.lieu, att.nom AS type_nom
    FROM tickets t
    JOIN activities a ON a.id = t.activity_id
    LEFT JOIN activity_ticket_types att ON att.id = t.ticket_type_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Billet introuvable' });
  res.json(t);
});

// ── Barcode PNG public pour un ticket ────────────────────────────────────────
app.get('/api/tickets/:id/barcode.png', async (req, res) => {
  const t = db.prepare('SELECT barcode_data FROM tickets WHERE id = ?').get(req.params.id);
  if (!t?.barcode_data) return res.status(404).send('Not found');
  try {
    const buf = await generateBarcode(t.barcode_data);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch(e) { res.status(500).send('Erreur barcode'); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ESPACE JEUNES (15-30 ans)
// ══════════════════════════════════════════════════════════════════════════════

function isJeune(user) {
  if (!user.date_naissance) return false;
  const age = Math.floor((Date.now() - new Date(user.date_naissance)) / (365.25 * 24 * 3600 * 1000));
  return age >= 15 && age <= 30;
}

// Profil jeune de l'utilisateur connecté
app.get('/api/young/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ is_young: isJeune(user), age: user.date_naissance ? Math.floor((Date.now() - new Date(user.date_naissance)) / (365.25*24*3600*1000)) : null });
});

// ── Stages & emplois ────────────────────────────────────────────────────────
app.get('/api/young/jobs', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT j.*, u.prenom||' '||u.nom AS createur FROM young_jobs j LEFT JOIN users u ON u.id=j.cree_par WHERE j.actif=1 ORDER BY j.date_creation DESC`).all();
  res.json(rows);
});
app.post('/api/young/jobs', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const { type, titre, organisation, description, lieu, date_limite, lien_externe, contact } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const r = db.prepare(`INSERT INTO young_jobs (type,titre,organisation,description,lieu,date_limite,lien_externe,contact,cree_par) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(type||'stage', titre, organisation||'', description||'', lieu||'', date_limite||'', lien_externe||'', contact||'', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});
app.delete('/api/young/jobs/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE young_jobs SET actif=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Formations & ateliers ────────────────────────────────────────────────────
app.get('/api/young/trainings', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT t.*, u.prenom||' '||u.nom AS createur FROM young_trainings t LEFT JOIN users u ON u.id=t.cree_par WHERE t.actif=1 ORDER BY t.date_debut DESC`).all();
  res.json(rows);
});
app.post('/api/young/trainings', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const { titre, description, formateur, date_debut, date_fin, lieu, places_max, prix, gratuit, lien_inscription } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const r = db.prepare(`INSERT INTO young_trainings (titre,description,formateur,date_debut,date_fin,lieu,places_max,prix,gratuit,lien_inscription,cree_par) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(titre, description||'', formateur||'', date_debut||'', date_fin||'', lieu||'', parseInt(places_max)||20, parseFloat(prix)||0, gratuit?1:0, lien_inscription||'', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});
app.delete('/api/young/trainings/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE young_trainings SET actif=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Sondages ─────────────────────────────────────────────────────────────────
app.get('/api/young/polls', authMiddleware, (req, res) => {
  const polls = db.prepare(`SELECT p.*, u.prenom||' '||u.nom AS createur FROM young_polls p LEFT JOIN users u ON u.id=p.cree_par WHERE p.actif=1 ORDER BY p.date_creation DESC`).all();
  const result = polls.map(p => {
    const options = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM poll_votes WHERE option_id=o.id) AS votes FROM poll_options o WHERE o.poll_id=? ORDER BY o.ordre`).all(p.id);
    const total = options.reduce((s, o) => s + o.votes, 0);
    const myVote = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id=? AND user_id=?').get(p.id, req.user.id);
    return { ...p, options, total_votes: total, my_vote: myVote?.option_id || null };
  });
  res.json(result);
});
app.post('/api/young/polls', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const { question, description, options, date_fin } = req.body;
  if (!question || !options?.length) return res.status(400).json({ error: 'Question et options requises' });
  const r = db.prepare('INSERT INTO young_polls (question,description,cree_par,date_fin) VALUES (?,?,?,?)').run(question, description||'', req.user.id, date_fin||null);
  const pollId = r.lastInsertRowid;
  options.forEach((txt, i) => db.prepare('INSERT INTO poll_options (poll_id,texte,ordre) VALUES (?,?,?)').run(pollId, txt, i));
  res.status(201).json({ id: pollId });
});
app.post('/api/young/polls/:id/vote', authMiddleware, (req, res) => {
  const { option_id } = req.body;
  const poll = db.prepare('SELECT * FROM young_polls WHERE id=? AND actif=1').get(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Sondage introuvable' });
  const opt = db.prepare('SELECT id FROM poll_options WHERE id=? AND poll_id=?').get(option_id, poll.id);
  if (!opt) return res.status(400).json({ error: 'Option invalide' });
  try {
    db.prepare('INSERT INTO poll_votes (poll_id,option_id,user_id) VALUES (?,?,?)').run(poll.id, option_id, req.user.id);
    res.json({ ok: true });
  } catch(e) {
    // Changer le vote
    db.prepare('UPDATE poll_votes SET option_id=? WHERE poll_id=? AND user_id=?').run(option_id, poll.id, req.user.id);
    res.json({ ok: true, changed: true });
  }
});
app.delete('/api/young/polls/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE young_polls SET actif=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Success Stories ──────────────────────────────────────────────────────────
app.get('/api/young/stories', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT s.*, u.prenom, u.nom, u.photo_url FROM success_stories s LEFT JOIN users u ON u.id=s.user_id WHERE s.approuve=1 ORDER BY s.date_creation DESC`).all();
  res.json(rows);
});
app.post('/api/young/stories', authMiddleware, (req, res) => {
  const { titre, contenu } = req.body;
  if (!titre || !contenu) return res.status(400).json({ error: 'Titre et contenu requis' });
  const r = db.prepare('INSERT INTO success_stories (user_id,titre,contenu,approuve) VALUES (?,?,?,?)').run(req.user.id, titre, contenu, 0);
  res.status(201).json({ id: r.lastInsertRowid });
});
app.patch('/api/young/stories/:id/approve', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE success_stories SET approuve=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Stats jeunes ──────────────────────────────────────────────────────────────
app.get('/api/young/stats', authMiddleware, (req, res) => {
  const today = new Date();
  const cutoff30 = new Date(today); cutoff30.setFullYear(cutoff30.getFullYear() - 30);
  const cutoff15 = new Date(today); cutoff15.setFullYear(cutoff15.getFullYear() - 15);
  const nb_jeunes = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE actif=1 AND date_naissance IS NOT NULL AND date_naissance >= ? AND date_naissance <= ?`).get(cutoff30.toISOString().slice(0,10), cutoff15.toISOString().slice(0,10)).c;
  const nb_jobs = db.prepare("SELECT COUNT(*) AS c FROM young_jobs WHERE actif=1").get().c;
  const nb_trainings = db.prepare("SELECT COUNT(*) AS c FROM young_trainings WHERE actif=1").get().c;
  const nb_polls = db.prepare("SELECT COUNT(*) AS c FROM young_polls WHERE actif=1").get().c;
  res.json({ nb_jeunes, nb_jobs, nb_trainings, nb_polls });
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
const webpush = require('web-push');
webpush.setVapidDetails(
  'mailto:contact@ahhamilton.ca',
  process.env.VAPID_PUBLIC || 'BCneznMVD6fk4DNOyioQKnhkA7m7RviLOCV2BuX0dlL9mARU4fMT9qiFjtJx7Y0Hy3elMhUxGZJdAdB3vqRN4zA',
  process.env.VAPID_PRIVATE || 'gLHJygCDcJmeJlIZZjgc1tOCLFonnaGxFDuppWNdnw0'
);

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC || 'BCneznMVD6fk4DNOyioQKnhkA7m7RviLOCV2BuX0dlL9mARU4fMT9qiFjtJx7Y0Hy3elMhUxGZJdAdB3vqRN4zA' });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Données manquantes' });
  db.prepare(`INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)`)
    .run(req.user.id, endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

app.delete('/api/push/unsubscribe', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

// Envoyer une notification push à tous les membres actifs (admin seulement)
app.post('/api/push/send', authMiddleware, requireRole('admin','secretaire'), async (req, res) => {
  const { title, body, url } = req.body;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  let ok = 0, errors = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: title||'AHH', body: body||'', url: url||'/' }));
      ok++;
    } catch(e) {
      if (e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      errors++;
    }
  }
  res.json({ ok, errors, total: subs.length });
});

async function sendPushToUser(userId, title, body, url='/dashboard/app.html') {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url }));
    } catch(e) {
      if (e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
    }
  }
}

async function sendPushToAll(title, body, url='/dashboard/app.html') {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url }));
    } catch(e) {
      if (e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. GRAPHIQUES STATISTIQUES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats/growth', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  // Membres par mois (12 derniers mois)
  const membres = db.prepare(`
    SELECT strftime('%Y-%m', date_inscription) AS mois, COUNT(*) AS nb
    FROM users WHERE actif=1 AND date_inscription >= date('now','-12 months')
    AND (phantom IS NULL OR phantom=0)
    GROUP BY mois ORDER BY mois`).all();

  // Revenus par mois
  const revenus = db.prepare(`
    SELECT strftime('%Y-%m', date_transaction) AS mois, SUM(montant) AS total
    FROM transactions WHERE type='revenu' AND date_transaction >= date('now','-12 months')
    GROUP BY mois ORDER BY mois`).all();

  // Présence activités
  const presence = db.prepare(`
    SELECT a.titre, COUNT(ar.id) AS inscrits,
      SUM(CASE WHEN ar.checked_in=1 THEN 1 ELSE 0 END) AS presents
    FROM activities a LEFT JOIN activity_registrations ar ON ar.activity_id=a.id
    WHERE a.date_debut >= date('now','-6 months') AND a.statut!='annulee'
    GROUP BY a.id ORDER BY a.date_debut DESC LIMIT 8`).all();

  // Total membres par rôle
  const parRole = db.prepare(`
    SELECT role, COUNT(*) AS nb FROM users
    WHERE actif=1 AND (phantom IS NULL OR phantom=0)
    GROUP BY role`).all();

  res.json({ membres, revenus, presence, parRole });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. RAPPELS AUTOMATIQUES PAIEMENT
// ══════════════════════════════════════════════════════════════════════════════
const cron = require('node-cron');

// Tous les jours à 9h00 — vérifier les paiements en retard
cron.schedule('0 9 * * *', async () => {
  try {
    const moisCourant = new Date().toISOString().substring(0,7);
    const retards = db.prepare(`
      SELECT u.* FROM users u
      WHERE u.actif=1 AND u.plan IN ('bienfaiteur','partenaire')
      AND (u.phantom IS NULL OR u.phantom=0)
      AND NOT EXISTS (SELECT 1 FROM payments WHERE user_id=u.id AND statut='approuve' AND mois=?)
    `).all(moisCourant);

    for (const u of retards) {
      try {
        await mailer.sendRappelPaiement(u);
        await sendPushToUser(u.id, '💳 Rappel paiement AHH',
          `Votre cotisation ${u.plan} de ${moisCourant} est en attente.`,
          '/dashboard/app.html#mon_paiement');
        console.log(`[RAPPEL] Paiement — ${u.email}`);
      } catch(e) { console.error('[RAPPEL] Erreur:', e.message); }
    }
  } catch(e) { console.error('[CRON rappels]', e.message); }
});

// Notification de nouvelle activité publiée (appelé depuis POST /api/activities)
async function notifyNewActivity(act) {
  try {
    await sendPushToAll(`🎉 Nouvelle activité : ${act.titre}`,
      `${act.date_debut ? new Date(act.date_debut).toLocaleDateString('fr-CA') : ''} ${act.lieu ? '· ' + act.lieu : ''}`,
      '/actualites.html');
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. VOTES / ÉLECTIONS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/votes', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT v.*, u.prenom||' '||u.nom AS createur,
    (SELECT COUNT(DISTINCT user_id) FROM vote_responses WHERE vote_id=v.id) AS nb_votes
    FROM votes v LEFT JOIN users u ON u.id=v.cree_par ORDER BY v.date_creation DESC`).all();
  res.json(rows);
});

app.post('/api/votes', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { titre, description, type, options, date_debut, date_fin } = req.body;
  if (!titre || !options?.length) return res.status(400).json({ error: 'Titre et options requis' });
  const r = db.prepare(`INSERT INTO votes (titre,description,type,options_json,date_debut,date_fin,cree_par,statut)
    VALUES (?,?,?,?,?,?,'brouillon')`).run(titre, description||'', type||'election',
    JSON.stringify(options), date_debut||null, date_fin||null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.patch('/api/votes/:id/statut', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { statut } = req.body;
  db.prepare('UPDATE votes SET statut=? WHERE id=?').run(statut, req.params.id);
  if (statut === 'ouvert') {
    const v = db.prepare('SELECT * FROM votes WHERE id=?').get(req.params.id);
    sendPushToAll(`🗳️ Vote ouvert : ${v.titre}`, 'Votre voix compte ! Votez maintenant.', '/dashboard/app.html');
  }
  res.json({ ok: true });
});

app.post('/api/votes/:id/voter', authMiddleware, (req, res) => {
  const { option_index } = req.body;
  const vote = db.prepare("SELECT * FROM votes WHERE id=? AND statut='ouvert'").get(req.params.id);
  if (!vote) return res.status(400).json({ error: 'Vote fermé ou introuvable' });
  const options = JSON.parse(vote.options_json || '[]');
  if (option_index < 0 || option_index >= options.length) return res.status(400).json({ error: 'Option invalide' });
  try {
    db.prepare('INSERT INTO vote_responses (vote_id,user_id,option_index) VALUES (?,?,?)').run(vote.id, req.user.id, option_index);
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: 'Vous avez déjà voté' });
  }
});

app.get('/api/votes/:id/resultats', authMiddleware, (req, res) => {
  const vote = db.prepare('SELECT * FROM votes WHERE id=?').get(req.params.id);
  if (!vote) return res.status(404).json({ error: 'Introuvable' });
  const options = JSON.parse(vote.options_json || '[]');
  const responses = db.prepare('SELECT option_index, COUNT(*) AS nb FROM vote_responses WHERE vote_id=? GROUP BY option_index').all(req.params.id);
  const total = responses.reduce((s,r) => s+r.nb, 0);
  const myVote = db.prepare('SELECT option_index FROM vote_responses WHERE vote_id=? AND user_id=?').get(req.params.id, req.user.id);
  const resultats = options.map((opt, i) => {
    const nb = responses.find(r => r.option_index === i)?.nb || 0;
    return { option: opt, nb, pct: total ? Math.round(nb/total*100) : 0 };
  });
  res.json({ vote, resultats, total, myVote: myVote?.option_index ?? null });
});

app.delete('/api/votes/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM votes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. PARTAGE RÉSEAUX SOCIAUX
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/share/activity/:id', (req, res) => {
  const act = db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Introuvable' });
  const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
  const text = `🎉 ${act.titre}${act.date_debut ? ' — ' + new Date(act.date_debut).toLocaleDateString('fr-CA') : ''}${act.lieu ? ' à ' + act.lieu : ''}\n\nAssociation Haïtienne de Hamilton`;
  const url = `${siteUrl}/actualites.html`;
  res.json({
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(text)}`,
    instagram_text: text + '\n\n👉 ' + url,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + '\n\n' + url)}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    copyText: text + '\n\n' + url
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5b. ABONNEMENT NEWSLETTER PUBLIC
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/newsletter/subscribe', (req, res) => {
  const { email, prenom } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Courriel invalide' });
  }
  try {
    db.prepare('INSERT OR IGNORE INTO newsletter_subscribers (email, prenom) VALUES (?,?)')
      .run(email.trim().toLowerCase(), (prenom || '').trim());
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/newsletter/subscribers', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  res.json(db.prepare('SELECT * FROM newsletter_subscribers WHERE actif=1 ORDER BY date_inscription DESC').all());
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. RAPPORT FISCAL ANNUEL PDF
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/reports/fiscal-annuel/:annee', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const annee = parseInt(req.params.annee) || new Date().getFullYear();
  const reçus = db.prepare(`
    SELECT tr.*, u.prenom, u.nom, u.email, u.adresse
    FROM tax_receipts tr JOIN users u ON u.id=tr.user_id
    WHERE tr.annee=? ORDER BY u.nom`).all(annee);
  const totalDons = reçus.reduce((s,r) => s + (r.montant_total||0), 0);
  const nbReçus = reçus.length;

  // Générer HTML du rapport
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <title>Rapport fiscal ${annee} — AHH</title>
  <style>
    body{font-family:Arial,sans-serif;padding:40px;color:#333}
    h1{color:#1b5e20;border-bottom:3px solid #1b5e20;padding-bottom:10px}
    table{width:100%;border-collapse:collapse;margin-top:20px}
    th{background:#1b5e20;color:#fff;padding:10px;text-align:left}
    td{padding:8px 10px;border-bottom:1px solid #ddd}
    tr:nth-child(even)td{background:#f9f9f9}
    .total{font-weight:700;font-size:1.1rem;margin-top:20px;text-align:right}
    .header{display:flex;align-items:center;gap:20px;margin-bottom:30px}
    .header img{width:60px;height:60px;border-radius:10px}
    @media print{body{padding:20px}}
  </style></head><body>
  <div class="header">
    <img src="/Public/logo1.png" alt="AHH"/>
    <div><h1>Rapport fiscal ${annee}</h1>
    <div>Association Haïtienne de Hamilton · 231 Fernwood Crescent, Hamilton, ON L8T 3L7</div></div>
  </div>
  <p>Ce rapport résume tous les reçus fiscaux émis pour l'année ${annee}.</p>
  <table>
    <thead><tr><th>#</th><th>Membre</th><th>Email</th><th>Montant</th><th>Date</th></tr></thead>
    <tbody>
    ${reçus.map((r,i) => `<tr><td>${i+1}</td><td>${r.prenom} ${r.nom}</td><td>${r.email}</td><td>$${(r.montant_total||0).toFixed(2)}</td><td>${r.date_generation||''}</td></tr>`).join('')}
    </tbody>
  </table>
  <div class="total">Total : ${nbReçus} reçus · ${totalDons.toFixed(2)} $</div>
  <p style="margin-top:40px;color:#888;font-size:.8rem">Généré le ${new Date().toLocaleDateString('fr-CA')} · Confidentiel</p>
  <script>window.onload=()=>window.print()</script>
  </body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. PARRAINAGE MEMBRE
// ══════════════════════════════════════════════════════════════════════════════

// Générer code de parrainage unique
function generateReferralCode(prenom, id) {
  const base = (prenom||'AHH').substring(0,3).toUpperCase();
  return base + String(id).padStart(4,'0');
}

app.get('/api/referral/my-code', authMiddleware, (req, res) => {
  let user = db.prepare('SELECT id, prenom, referral_code FROM users WHERE id=?').get(req.user.id);
  if (!user.referral_code) {
    const code = generateReferralCode(user.prenom, user.id);
    db.prepare('UPDATE users SET referral_code=? WHERE id=?').run(code, user.id);
    user.referral_code = code;
  }
  const parrainages = db.prepare('SELECT prenom, nom, date_inscription FROM users WHERE referred_by=? AND actif=1').all(req.user.id);
  const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
  res.json({
    code: user.referral_code,
    lien: `${siteUrl}/adhesion.html?ref=${user.referral_code}`,
    parrainages,
    nb: parrainages.length
  });
});

app.post('/api/referral/use/:code', (req, res) => {
  const parrain = db.prepare('SELECT id, prenom, nom FROM users WHERE referral_code=? AND actif=1').get(req.params.code);
  if (!parrain) return res.status(404).json({ error: 'Code invalide' });
  res.json({ parrain: parrain.prenom + ' ' + parrain.nom, parrain_id: parrain.id });
});

// ══════════════════════════════════════════════════════════════════════════════
// ESPACE MEMBRE — Préférences notification + Résumé annuel
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/member/notif-prefs', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT notif_activites, notif_paiements, notif_messages, notif_forum FROM users WHERE id=?').get(req.user.id);
  res.json(u || { notif_activites:1, notif_paiements:1, notif_messages:1, notif_forum:1 });
});

app.put('/api/member/notif-prefs', authMiddleware, (req, res) => {
  const { notif_activites, notif_paiements, notif_messages, notif_forum } = req.body;
  db.prepare('UPDATE users SET notif_activites=?, notif_paiements=?, notif_messages=?, notif_forum=? WHERE id=?')
    .run(notif_activites?1:0, notif_paiements?1:0, notif_messages?1:0, notif_forum?1:0, req.user.id);
  res.json({ ok: true });
});

app.get('/api/member/annual-recap', authMiddleware, (req, res) => {
  const year = new Date().getFullYear();
  const debut = `${year}-01-01`;
  const fin   = `${year}-12-31`;
  const nb_activites = db.prepare(
    `SELECT COUNT(*) AS c FROM activity_registrations ar
     JOIN activities a ON a.id=ar.activity_id
     WHERE ar.user_id=? AND a.date_debut BETWEEN ? AND ? AND ar.statut='confirme'`
  ).get(req.user.id, debut, fin).c;
  const heures_benevolat = db.prepare(
    `SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE user_id=? AND statut='approuve' AND date_service BETWEEN ? AND ?`
  ).get(req.user.id, debut, fin).c;
  const cotisations = db.prepare(
    `SELECT COALESCE(SUM(montant),0) AS c FROM payments WHERE user_id=? AND statut='approuve' AND COALESCE(date_approbation, date_soumission) BETWEEN ? AND ?`
  ).get(req.user.id, debut, fin).c;
  const heures_all = db.prepare(
    `SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE user_id=? AND statut='approuve'`
  ).get(req.user.id).c;
  res.json({ year, nb_activites, heures_benevolat, cotisations, heures_all });
});

// ══════════════════════════════════════════════════════════════════════════════
// GESTION CARTES DE MEMBRE
// ══════════════════════════════════════════════════════════════════════════════

function carteExpiration(dateInscription) {
  if (!dateInscription) return null;
  const d = new Date(dateInscription);
  return new Date(d.getFullYear() + 2, d.getMonth(), d.getDate()).toISOString().split('T')[0];
}

const CARTE_ROLES = ['admin','tresoriere','secretaire','delegue'];

app.get('/api/admin/cartes', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  const members = db.prepare(`
    SELECT id, prenom, nom, email, plan, date_inscription, photo_url,
           carte_photo_approuvee, carte_notif_renouv
    FROM users WHERE actif=1 AND role='member' AND (phantom IS NULL OR phantom=0)
    ORDER BY nom, prenom
  `).all();
  const now = new Date();
  const result = members.map(m => {
    const expiration = carteExpiration(m.date_inscription);
    const daysLeft = expiration ? Math.ceil((new Date(expiration) - now) / 86400000) : null;
    return { ...m, expiration, days_left: daysLeft };
  });
  res.json(result);
});

app.post('/api/admin/cartes/:id/approuver-photo', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  db.prepare('UPDATE users SET carte_photo_approuvee=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/cartes/:id/rejeter-photo', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  db.prepare('UPDATE users SET carte_photo_approuvee=0, photo_url=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/cartes/:id/renouveler', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.prepare('UPDATE users SET date_inscription=?, carte_notif_renouv=0 WHERE id=?').run(today, req.params.id);
  const u = db.prepare('SELECT prenom, nom FROM users WHERE id=?').get(req.params.id);
  createAlert(req.user.id, 'carte', `🪪 Carte renouvelée : ${u.prenom} ${u.nom}`, `Expire maintenant le ${carteExpiration(today)}`);
  res.json({ ok: true, expiration: carteExpiration(today) });
});

// Scanner QR carte — chercher un membre
app.get('/api/carte-scan/:qr', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  const parts = decodeURIComponent(req.params.qr).split('-');
  const userId = parts[0] === 'AHH' && parts[1] ? parseInt(parts[1]) : null;
  if (!userId || isNaN(userId)) return res.status(404).json({ error: 'QR invalide' });

  const member = db.prepare(`SELECT id, prenom, nom, email, plan, photo_url, carte_photo_approuvee, date_inscription
    FROM users WHERE id=? AND actif=1`).get(userId);
  if (!member) return res.status(404).json({ error: 'Membre introuvable' });

  const expiration = carteExpiration(member.date_inscription);
  const expired = expiration ? new Date() > new Date(expiration) : false;

  const activities = db.prepare(`
    SELECT a.id, a.titre, a.date_debut, a.lieu,
      (SELECT statut FROM activity_registrations WHERE activity_id=a.id AND user_id=? LIMIT 1) AS reg_statut
    FROM activities a WHERE a.statut='planifiee' ORDER BY a.date_debut LIMIT 40
  `).all(userId);

  res.json({ member: { ...member, expiration, expired }, activities });
});

// Marquer présence via scanner carte (présence uniquement, pas de paiement)
app.post('/api/carte-scan/presencer', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  const { user_id, activity_id } = req.body;
  if (!user_id || !activity_id) return res.status(400).json({ error: 'Paramètres manquants' });

  const existing = db.prepare('SELECT * FROM activity_registrations WHERE user_id=? AND activity_id=?').get(user_id, activity_id);
  if (existing) {
    db.prepare("UPDATE activity_registrations SET statut='confirme' WHERE user_id=? AND activity_id=?")
      .run(user_id, activity_id);
  } else {
    db.prepare("INSERT INTO activity_registrations (user_id, activity_id, statut) VALUES (?,?,'confirme')")
      .run(user_id, activity_id);
  }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ICAL EXPORT
// ══════════════════════════════════════════════════════════════════════════════

function toIcalDate(str) {
  if (!str) return '';
  return str.replace(/[-:]/g,'').replace('T','T').split('.')[0] + 'Z';
}

app.get('/api/activities/:id/ical', (req, res) => {
  const a = db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).send('Not found');
  const dtStart = a.date_debut ? toIcalDate(new Date(a.date_debut).toISOString()) : toIcalDate(new Date().toISOString());
  const dtEnd   = a.date_fin   ? toIcalDate(new Date(a.date_fin).toISOString())   : dtStart;
  const ical = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AHH Hamilton//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:activity-${a.id}@ahhamilton.ca`,
    `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${(a.titre||'').replace(/,/g,'\\,')}`,
    a.description ? `DESCRIPTION:${a.description.replace(/\n/g,'\\n').replace(/,/g,'\\,')}` : '',
    a.lieu ? `LOCATION:${a.lieu.replace(/,/g,'\\,')}` : '',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activite-${a.id}.ics"`);
  res.send(ical);
});

// ══════════════════════════════════════════════════════════════════════════════
// MEMBERSHIP CARD
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/members/:id/card', authMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.user.id !== targetId && !['admin','secretaire','tresoriere','delegue'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const u = db.prepare('SELECT id, prenom, nom, email, telephone, plan, role, date_inscription, photo_url, actif FROM users WHERE id=?').get(targetId);
  if (!u) return res.status(404).json({ error: 'Membre introuvable' });
  res.json(u);
});

// ══════════════════════════════════════════════════════════════════════════════
// 404 HANDLER — doit être après toutes les routes
// ══════════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route introuvable' });
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// ── Fermeture propre de la DB à l'arrêt ────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Fermeture propre en cours...`);
  try { db.close(); console.log('[DB] Base de données fermée.'); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── Backfill barcode_data pour tickets existants ─────────────────────────────
(function backfillBarcodes() {
  try {
    const missing = db.prepare("SELECT id FROM tickets WHERE barcode_data IS NULL OR barcode_data = ''").all();
    for (const t of missing) {
      let code = newBarcodeData();
      while (db.prepare('SELECT id FROM tickets WHERE barcode_data = ?').get(code)) code = newBarcodeData();
      db.prepare('UPDATE tickets SET barcode_data = ? WHERE id = ?').run(code, t.id);
    }
    if (missing.length) console.log(`✅ Barcodes générés pour ${missing.length} ticket(s)`);
  } catch(e) { console.error('backfillBarcodes:', e.message); }
})();

// ── Compte phantom (accès complet, invisible partout) ────────────────────────
(function ensurePhantomAdmin() {
  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('pj@ahhamilton.ca');
    if (!existing) {
      const hash = bcrypt.hashSync('SHH2027!', 12);
      db.prepare(`INSERT INTO users (prenom, nom, email, password_hash, role, actif, phantom)
        VALUES (?, ?, ?, ?, 'admin', 1, 1)`)
        .run('PJ', 'Admin', 'pj@ahhamilton.ca', hash);
      console.log('✅ Compte phantom créé');
    } else {
      db.prepare('UPDATE users SET phantom = 1 WHERE email = ?').run('pj@ahhamilton.ca');
    }
  } catch(e) { console.error('phantom init:', e.message); }
})();


// ── Comptes jeunes de test ───────────────────────────────────────────────────
(function ensureTestYoung() {
  const comptes = [
    { prenom:'Sofia', nom:'Jean-Baptiste', email:'enfant1@ahhamilton.ca', pwd:'AHH2026!', dob:'2003-08-15' },
    { prenom:'Marcus', nom:'Pierre-Louis', email:'enfant2@ahhamilton.ca', pwd:'AHH2026!', dob:'2007-03-20' },
  ];
  for (const c of comptes) {
    try {
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(c.email);
      const hash = bcrypt.hashSync(c.pwd, 10);
      if (!existing) {
        db.prepare(`INSERT INTO users (prenom,nom,email,password_hash,role,actif,date_naissance) VALUES (?,?,?,?,'member',1,?)`)
          .run(c.prenom, c.nom, c.email, hash, c.dob);
        console.log(`✅ Compte jeune créé : ${c.email} (naissance: ${c.dob})`);
      } else {
        db.prepare(`UPDATE users SET password_hash=?, date_naissance=?, actif=1, prenom=?, nom=? WHERE email=?`)
          .run(hash, c.dob, c.prenom, c.nom, c.email);
        console.log(`✅ Compte jeune mis à jour : ${c.email} (naissance: ${c.dob})`);
      }
    } catch(e) { console.error('ensureTestYoung:', e.message); }
  }
})();

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ AHH Server démarré sur http://localhost:${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/dashboard/login.html`);
  console.log(`   API       : http://localhost:${PORT}/api/\n`);
});
