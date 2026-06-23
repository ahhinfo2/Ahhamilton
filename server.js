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
 'uploads/payments','uploads/talents','uploads/annonces','uploads/attachments','uploads/activities','uploads/qr','uploads/forms','uploads/shop']
  .forEach(d => { const p = path.join(__dirname, d); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); });

const db = require('./db/database');
const { authMiddleware, requireRole, JWT_SECRET } = require('./middleware/auth');
const mailer = require('./mailer');
const imap   = require('./imap');

// ── SMS via email-to-SMS gateway (gratuit) ──────────────────────────────────
function sendSMS(phone, message) {
  if (!phone) return Promise.resolve();
  return mailer.sendSMS({ telephone: phone, operateur: 'rogers', sms_notifs: 1 }, message).catch(function() {});
}

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
    // ── Cotisation en ligne ─────────────────────────────────────────────────
    if (session.metadata?.type === 'cotisation') {
      const userId = parseInt(session.metadata.user_id);
      const plan     = session.metadata.plan;
      const periode  = session.metadata.periode;
      const nbMois   = parseInt(session.metadata.nb_mois) || 1;
      const periodicite = session.metadata.periodicite || 'mensuel';
      if (userId) {
        db.prepare(`INSERT INTO payments (user_id,montant,methode,statut,mois,periodicite,reference,date_soumission)
          VALUES (?,?,'stripe','approuve',?,?,?,datetime('now'))`)
          .run(userId, montant, periode, periodicite, ref);
        db.prepare("UPDATE users SET plan_paid_month=? WHERE id=?").run(periode, userId);
        const existCot = db.prepare('SELECT id FROM cotisations WHERE user_id=? AND periode=?').get(userId, periode);
        if (!existCot) {
          db.prepare("INSERT INTO cotisations (user_id,periode,statut,montant) VALUES (?,?,'paye',?)").run(userId, periode, montant);
        } else {
          db.prepare("UPDATE cotisations SET statut='paye',montant=? WHERE user_id=? AND periode=?").run(montant, userId, periode);
        }
        createAlert(userId, 'paiement', '✅ Paiement confirmé', `Cotisation $${montant.toFixed(2)} reçue et approuvée (paiement en ligne).`);
        // Envoyer reçu fiscal automatique par email
        try {
          const userForReceipt = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
          if (userForReceipt) {
            const payRow = db.prepare('SELECT id FROM payments WHERE user_id=? AND statut=? AND mois=? ORDER BY id DESC LIMIT 1').get(userId,'approuve',periode);
            await mailer.sendRecuFiscalAuto(userForReceipt, Math.round(montant*100), periode, payRow?.id || 0);
          }
        } catch(e) { console.error('[RECU AUTO]', e.message); }
        console.log(`✅ Cotisation Stripe — user ${userId} plan ${plan} — $${montant} — ${periode}`);
      }
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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
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

app.use('/', express.static(path.join(__dirname), { maxAge: 86400000, setHeaders: (res, filePath) => {
  if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
} }));

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

// ── Multer : documents officiels ─────────────────────────────────────────────
const docsStorage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname,'uploads','documents'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`)
});
const uploadDoc = multer({ storage: docsStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Helper ──────────────────────────────────────────────────────────────────
function createAlert(destinataireId, type, titre, contenu, sourceId = null) {
  db.prepare(`INSERT INTO alerts (destinataire_id, type, titre, contenu, source_id)
              VALUES (?, ?, ?, ?, ?)`).run(destinataireId, type, titre, contenu, sourceId);
  sseNotify([destinataireId], { type: 'alerte', alertType: type, titre, contenu });
}

function logAdmin(userId, action, details, cibleId = null, cibleType = null, ip = null) {
  try {
    db.prepare(`INSERT INTO activity_logs (user_id, action, details, cible_id, cible_type, ip) VALUES (?,?,?,?,?,?)`)
      .run(userId, action, details || '', cibleId, cibleType, ip);
  } catch {}
}

function logAudit(userId, action, cible, cibleId, details, ip) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, action, cible, cible_id, details, ip) VALUES (?,?,?,?,?,?)`)
      .run(userId || null, action, cible || null, cibleId || null, details || null, ip || null);
  } catch {}
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

  db.prepare("UPDATE users SET nb_connexions = nb_connexions + 1, derniere_connexion = datetime('now') WHERE id = ?").run(user.id);

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, prenom: user.prenom, nom: user.nom, date_naissance: user.date_naissance },
    JWT_SECRET, { expiresIn: '24h' }
  );
  logAudit(user.id, 'login', 'user', user.id, `Connexion réussie — ${user.email}`, req.ip);
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
    });
    const staffEmails = staff.map(s => s.email).filter(Boolean);
    const extraEmails = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim())
      .filter(addr => addr && addr.toLowerCase() !== email.toLowerCase());
    const allNotify = [...new Set([...staffEmails, ...extraEmails])];
    mailer.sendNouvelleAdhesion(allNotify, candidat).catch(e => console.error(`sendNouvelleAdhesion:`, e.message));
  } else {
    const extraEmails = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim())
      .filter(addr => addr && addr.toLowerCase() !== email.toLowerCase());
    if (extraEmails.length) mailer.sendNouvelleAdhesion(extraEmails, candidat).catch(e => console.error(`sendNouvelleAdhesion:`, e.message));
  }
  res.status(201).json({ message: 'Demande envoyée. Vous recevrez un courriel après approbation.' });
});

// ── Gestion des inscriptions en attente (admin) ────────────────────────────
app.get('/api/inscriptions', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  res.json(db.prepare('SELECT * FROM pending_registrations ORDER BY date_soumission DESC').all());
});

// ── Invitation par email (comité → futur membre) ────────────────────────────
app.post('/api/admin/invite', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Cette personne est déjà membre' });
  if (db.prepare("SELECT id FROM pending_registrations WHERE email = ? AND statut = 'en_attente'").get(email))
    return res.status(409).json({ error: 'Une demande est déjà en attente pour cet email' });
  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  const inviteLink = `${siteUrl}/adhesion.html?email=${encodeURIComponent(email)}`;
  try {
    await mailer.sendInvitation(email, inviteLink);
    res.json({ message: `Invitation envoyée à ${email}` });
  } catch(e) {
    console.error('sendInvitation:', e.message);
    res.status(500).json({ error: 'Échec d\'envoi : ' + e.message });
  }
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
  const _siteUrl2 = process.env.SITE_URL || 'https://ahhamilton.ca';
  const welcomeMsg = `Bonjour ${p.prenom},\n\nJe suis Jean-Carme Dorcent, présidente de l'Association Haïtienne de Hamilton (AHH).\n\nC'est avec grand plaisir que je vous souhaite la bienvenue dans notre famille ! Depuis 18 ans, l'AHH œuvre pour le rayonnement et l'épanouissement de la communauté haïtienne de Hamilton.\n\nVotre adhésion a été approuvée. Vous pouvez maintenant vous connecter à votre espace membre :\n${_siteUrl2}/dashboard/login.html\n\nAu plaisir de vous retrouver lors de nos prochaines activités !\n\nChaleureusement,\nJean-Carme Dorcent\nPrésidente — AHH Hamilton`;

  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (adminId) {
    const wMsg = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
      .run(adminId.id, 'Bienvenue dans l\'Association Haïtienne de Hamilton !', welcomeMsg);
    db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(wMsg.lastInsertRowid, newUserId);
  }
  createAlert(newUserId, 'inscription', 'Bienvenue à AHH !', 'Votre adhésion a été approuvée.');

  // Générer un token de création de mot de passe (valide 7 jours)
  const crypto = require('crypto');
  const token  = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600000).toISOString();
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(newUserId, token, expires);
  const siteUrl   = process.env.SITE_URL || `http://localhost:${PORT}`;
  const resetLink = `${siteUrl}/dashboard/reset-password.html?token=${token}`;

  // Courriel de bienvenue avec lien direct de création de mot de passe
  mailer.sendBienvenue(p, resetLink).catch(e => console.error('Email bienvenue:', e.message));

  // Ajouter aux salons de chat
  const generalRoom = db.prepare("SELECT id FROM chat_rooms WHERE type='general'").get();
  if (generalRoom) db.prepare('INSERT OR IGNORE INTO chat_room_members (room_id, user_id) VALUES (?,?)').run(generalRoom.id, newUserId);

  logAudit(req.user.id, 'member_approved', 'user', newUserId, `Membre approuvé: ${p.prenom} ${p.nom} (${p.email})`, req.ip);
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

app.get('/api/membres/anniversaires', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const mois = new Date().getMonth() + 1;
  const rows = db.prepare(`SELECT id, prenom, nom, date_naissance, photo_url FROM users
    WHERE actif=1 AND (phantom IS NULL OR phantom=0)
    AND date_naissance IS NOT NULL AND date_naissance != ''
    AND CAST(strftime('%m', date_naissance) AS INTEGER) = ?
    ORDER BY strftime('%d', date_naissance)`).all(mois);
  res.json(rows);
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

const ambassadorPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'ambassador');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `ambassador_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadAmbassador = multer({ storage: ambassadorPhotoStorage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/users/:id/photo', authMiddleware, uploadProfile.single('photo'), async (req, res) => {
  if (req.user.id !== parseInt(req.params.id) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Accès refusé' });
  if (!req.file) return res.status(400).json({ error: 'Photo requise' });
  await compressImage(req.file.path, 1200);
  const photo_url = `/uploads/profiles/${req.file.filename}`;
  db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run(photo_url, req.params.id);
  res.json({ photo_url });
});
app.use('/uploads/profiles', express.static(path.join(__dirname, 'uploads', 'profiles')));

app.delete('/api/users/:id', authMiddleware, requireRole('admin','secretaire','delegue','tresoriere'), (req, res) => {
  const uid = parseInt(req.params.id);
  if (uid === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer vous-même' });
  const deletedUser = db.prepare('SELECT prenom, nom, email FROM users WHERE id = ?').get(uid);
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
    logAudit(req.user.id, 'member_deleted', 'user', uid, `Membre supprimé: ${deletedUser ? deletedUser.prenom + ' ' + deletedUser.nom + ' (' + deletedUser.email + ')' : 'id=' + uid}`, req.ip);
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
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = a.id AND user_id = ?) AS user_registered,
    COALESCE(a.image_path, (SELECT photo_path FROM activity_photos WHERE activity_id = a.id ORDER BY ordre ASC, id ASC LIMIT 1)) AS flyer
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

// ── Image compression helper ─────────────────────────────────────────────
async function compressImage(filePath, maxWidth) {
  try {
    const img = await jimp.Jimp.read(filePath);
    if (img.width > (maxWidth || 1200)) {
      img.resize({ w: maxWidth || 1200 });
    }
    await img.write(filePath);
  } catch(e) { console.error('[COMPRESS]', e.message); }
}

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
          prix, paiement_requis, rabais_json, recurrence, recurrence_end, stream_url, stream_actif } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });

  const qr_token = crypto2.randomBytes(16).toString('hex');
  const r = db.prepare(`INSERT INTO activities
    (titre, description, type, date_debut, date_fin, lieu, budget_prevu, max_participants, cree_par,
     prix, paiement_requis, rabais_json, qr_token, recurrence, recurrence_end, stream_url, stream_actif)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(titre, description||'', type||'general', date_debut||'', date_fin||'', lieu||'',
         budget_prevu||0, max_participants||null, req.user.id,
         parseFloat(prix)||0, paiement_requis?1:0,
         rabais_json||'{}', qr_token, recurrence||null, recurrence_end||null,
         stream_url||null, stream_actif?1:0);
  const parentId = r.lastInsertRowid;
  // Créer ligne financière immédiatement si budget prévu
  if (budget_prevu && parseFloat(budget_prevu) > 0) {
    db.prepare(`INSERT OR IGNORE INTO financial_lines (activity_id, titre, budget_alloue) VALUES (?, ?, ?)`)
      .run(parentId, `Budget – ${titre}`, parseFloat(budget_prevu));
  }
  // ── Générer les occurrences récurrentes ──────────────────────────────
  if (recurrence && recurrence !== 'none' && date_debut) {
    const patterns = { weekly: 7, biweekly: 14, monthly: 30 };
    const days = patterns[recurrence] || 0;
    if (days > 0) {
      const endDate = recurrence_end ? new Date(recurrence_end) : new Date(Date.now() + 90*24*60*60*1000);
      let currentStart = new Date(date_debut);
      const duration = (date_fin && date_debut) ? (new Date(date_fin).getTime() - new Date(date_debut).getTime()) : 0;
      while (true) {
        currentStart = new Date(currentStart.getTime() + days * 24*60*60*1000);
        if (currentStart > endDate) break;
        const childEnd = duration ? new Date(currentStart.getTime() + duration).toISOString() : '';
        const childQr = crypto2.randomBytes(16).toString('hex');
        db.prepare(`INSERT INTO activities (titre,description,type,date_debut,date_fin,lieu,budget_prevu,max_participants,statut,cree_par,prix,paiement_requis,rabais_json,qr_token,parent_activity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(titre, description||'', type||'general', currentStart.toISOString(), childEnd, lieu||'',
               0, max_participants||null, 'planifiee', req.user.id,
               parseFloat(prix)||0, paiement_requis?1:0, rabais_json||'{}', childQr, parentId);
      }
    }
  }
  res.status(201).json({ id: parentId, qr_token });

  // Notifier les abonnés newsletter (non-bloquant)
  setImmediate(async () => {
    try {
      const subscribers = db.prepare("SELECT email, prenom FROM newsletter_subscribers WHERE actif=1").all();
      if (!subscribers.length) return;
      const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
      const dateStr = date_debut
        ? new Date(date_debut).toLocaleDateString('fr-CA', { dateStyle: 'long' })
        : '';
      const typeLabel = { culturel:'Culturel', benevolat:'Bénévolat', social:'Social', reunion:'Réunion', general:'Général' }[type] || (type||'');
      for (const sub of subscribers) {
        await mailer.sendMail({
          to: sub.email,
          subject: `Nouvelle activité AHH : ${titre}`,
          html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f4f7f4;margin:0;padding:0">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(27,94,32,.1)">
  <div style="background:linear-gradient(135deg,#003F87,#D21034);padding:28px 32px;text-align:center">
    <img src="${siteUrl}/Public/logo1.png" alt="AHH" style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:2px solid rgba(255,255,255,.3)"/>
    <h1 style="color:#fff;font-size:1.15rem;font-weight:700;margin:10px 0 0">Association Haïtienne de Hamilton</h1>
  </div>
  <div style="padding:32px">
    <h2 style="color:#003F87;font-size:1.1rem;margin:0 0 18px">📅 Nouvelle activité</h2>
    <p style="color:#3a3a3a;font-size:.9rem;line-height:1.7;margin:0 0 14px">
      Bonjour${sub.prenom ? ' <strong>' + sub.prenom + '</strong>' : ''},
    </p>
    <p style="color:#3a3a3a;font-size:.9rem;line-height:1.7;margin:0 0 20px">
      L'<strong>Association Haïtienne de Hamilton</strong> vous invite à son prochain événement :
    </p>
    <div style="background:#f0f4ff;border-left:4px solid #003F87;border-radius:8px;padding:20px;margin-bottom:20px">
      <div style="font-size:1.2rem;font-weight:800;color:#003F87;margin-bottom:10px">${titre}</div>
      ${typeLabel ? `<div style="font-size:.82rem;color:#666;margin-bottom:6px">🏷️ ${typeLabel}</div>` : ''}
      ${dateStr ? `<div style="font-size:.9rem;color:#333;margin-bottom:6px">📅 <strong>${dateStr}</strong></div>` : ''}
      ${lieu ? `<div style="font-size:.9rem;color:#333;margin-bottom:6px">📍 ${lieu}</div>` : ''}
      ${description ? `<div style="font-size:.85rem;color:#555;margin-top:10px;line-height:1.6">${description}</div>` : ''}
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="${siteUrl}/actualites.html" style="display:inline-block;background:linear-gradient(135deg,#003F87,#D21034);color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-weight:700;font-size:.95rem">
        Voir toutes les activités
      </a>
    </div>
    <hr style="border:none;border-top:1px solid #e8f0fe;margin:20px 0"/>
    <p style="font-size:.75rem;color:#aaa;text-align:center">
      Vous recevez ce courriel car vous êtes abonné aux nouvelles de l'AHH.<br/>
      Pour vous désabonner, répondez avec « désabonnement ».<br/>
      © 2026 Association Haïtienne de Hamilton
    </p>
  </div>
</div>
</body></html>`
        }).catch(e => console.error(`[newsletter activity] ${sub.email}:`, e.message));
      }
      console.log(`📧 Newsletter activité "${titre}" envoyée à ${subscribers.length} abonné(s)`);
    } catch(e) {
      console.error('[newsletter activity auto-email]', e.message);
    }
  });
});

app.put('/api/activities/:id', authMiddleware, requireRole(...ACTIVITY_ROLES), (req, res) => {
  const { titre, description, type, date_debut, date_fin, lieu, budget_prevu, max_participants, statut,
          prix, paiement_requis, rabais_json, stream_url, stream_actif } = req.body;
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
    // Twilio SMS — membres avec téléphone (sans doublon si déjà envoyé via gateway)
    const membresTwilio = db.prepare("SELECT telephone FROM users WHERE actif=1 AND telephone IS NOT NULL AND telephone != '' AND (operateur IS NULL OR sms_notifs=0)").all();
    membresTwilio.forEach(m => sendSMS(m.telephone, smsText).catch(() => {}));
  }

  db.prepare(`UPDATE activities SET titre=?, description=?, type=?, date_debut=?, date_fin=?, lieu=?,
    budget_prevu=?, max_participants=?, statut=?, prix=?, paiement_requis=?, rabais_json=?,
    stream_url=?, stream_actif=? WHERE id=?`)
    .run(titre||prev.titre, description??prev.description, type||prev.type, date_debut||prev.date_debut,
         date_fin||prev.date_fin, lieu||prev.lieu, budget_prevu??prev.budget_prevu,
         max_participants??prev.max_participants, statut||prev.statut,
         prix!==undefined ? parseFloat(prix)||0 : prev.prix||0,
         paiement_requis!==undefined ? (paiement_requis?1:0) : prev.paiement_requis||0,
         rabais_json||prev.rabais_json||'{}',
         stream_url!==undefined ? stream_url : prev.stream_url||null,
         stream_actif!==undefined ? (stream_actif?1:0) : prev.stream_actif||0,
         req.params.id);
  res.json({ message: 'Activité mise à jour' });
});

app.post('/api/activities/:id/image', authMiddleware, requireRole(...ACTIVITY_ROLES), uploadActivityPhoto.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image requise' });
  await compressImage(req.file.path, 1200);
  const imagePath = `/uploads/activities/${req.params.id}/${req.file.filename}`;
  db.prepare('UPDATE activities SET image_path=? WHERE id=?').run(imagePath, req.params.id);
  res.json({ image_path: imagePath });
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

app.post('/api/activities/:id/duplicate', authMiddleware, requireRole(...ACTIVITY_ROLES), (req, res) => {
  const orig = db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id);
  if (!orig) return res.status(404).json({ error: 'Activité introuvable' });
  const qr_token = crypto2.randomBytes(16).toString('hex');
  const r = db.prepare(`INSERT INTO activities (titre, description, type, date_debut, date_fin, lieu, budget_prevu, max_participants, cree_par, prix, paiement_requis, rabais_json, qr_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('Copie — ' + orig.titre, orig.description, orig.type, orig.date_debut, orig.date_fin, orig.lieu,
         orig.budget_prevu||0, orig.max_participants, req.user.id,
         orig.prix||0, orig.paiement_requis||0, orig.rabais_json||'{}', qr_token);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.post('/api/activities/:id/register', authMiddleware, (req, res) => {
  try {
    const actId = parseInt(req.params.id);
    const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(actId);
    if (!act) return res.status(404).json({ error: 'Activité introuvable' });
    // Vérifier si déjà inscrit (y compris sur la liste d'attente)
    const existing = db.prepare('SELECT * FROM activity_registrations WHERE activity_id = ? AND user_id = ?').get(actId, req.user.id);
    if (existing) return res.status(409).json({ error: 'Déjà inscrit' });
    // Vérifier la capacité
    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM activity_registrations WHERE activity_id = ? AND waitlist = 0').get(actId).c;
    if (act.max_participants > 0 && currentCount >= act.max_participants) {
      // Ajouter à la liste d'attente
      const waitlistCount = db.prepare('SELECT COUNT(*) AS c FROM activity_registrations WHERE activity_id = ? AND waitlist = 1').get(actId).c;
      db.prepare("INSERT INTO activity_registrations (activity_id, user_id, statut, waitlist) VALUES (?,?,'en_attente',1)").run(actId, req.user.id);
      return res.json({ ok: true, waitlist: true, position: waitlistCount + 1 });
    }
    db.prepare('INSERT INTO activity_registrations (activity_id, user_id) VALUES (?, ?)')
      .run(actId, req.user.id);
    if (act) mailer.sendInscriptionActivite(req.user, act).catch(()=>{});
    res.status(201).json({ message: 'Inscription confirmée' });
  } catch(e) {
    res.status(409).json({ error: 'Déjà inscrit' });
  }
});

app.delete('/api/activities/:id/register', authMiddleware, (req, res) => {
  const actId = parseInt(req.params.id);
  const reg = db.prepare('SELECT * FROM activity_registrations WHERE activity_id = ? AND user_id = ?').get(actId, req.user.id);
  db.prepare('DELETE FROM activity_registrations WHERE activity_id = ? AND user_id = ?')
    .run(actId, req.user.id);
  // Auto-promouvoir le premier en liste d'attente
  if (reg && reg.waitlist === 0) {
    const next = db.prepare('SELECT * FROM activity_registrations WHERE activity_id = ? AND waitlist = 1 ORDER BY date_inscription ASC LIMIT 1').get(actId);
    if (next) {
      db.prepare("UPDATE activity_registrations SET waitlist = 0, statut = 'inscrit' WHERE id = ?").run(next.id);
      // Notifier le membre promu
      try {
        const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(actId);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(next.user_id);
        if (act && user) {
          db.prepare("INSERT INTO alerts (type, titre, contenu, destinataire_id, source_id) VALUES (?,?,?,?,?)")
            .run('activite', 'Place disponible !', `Une place s'est libérée pour "${act.titre}". Vous avez été automatiquement inscrit(e).`, next.user_id, actId);
          mailer.sendInscriptionActivite(user, act).catch(()=>{});
        }
      } catch(_) {}
    }
  }
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

app.get('/api/finance/lines', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
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

app.get('/api/finance/chart', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date_transaction) AS mois,
           SUM(CASE WHEN type='revenu'  THEN montant ELSE 0 END) AS revenus,
           SUM(CASE WHEN type='depense' THEN montant ELSE 0 END) AS depenses
    FROM transactions
    WHERE date_transaction >= date('now', '-12 months')
    GROUP BY mois ORDER BY mois ASC`).all();
  res.json(rows);
});

app.get('/api/finance/summary', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
  const account = db.prepare('SELECT * FROM account_info WHERE id = 1').get() || {};
  const actCount = db.prepare("SELECT COUNT(*) AS cnt FROM activities WHERE statut IN ('planifiee','en_cours')").get().cnt;
  const projCount = db.prepare("SELECT COUNT(*) AS cnt FROM projects WHERE statut IN ('en_cours','planifie')").get().cnt;
  res.json({ solde: account.solde || 0, projets_en_cours: actCount + projCount });
});

app.get('/api/finance/transactions', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
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

app.get('/api/finance/account', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
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
app.get('/api/finance/invoices', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
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

// Vider la corbeille (suppression définitive de tous les messages dans la corbeille)
app.delete('/api/messages/trash/empty', authMiddleware, (req, res) => {
  const r1 = db.prepare('DELETE FROM message_recipients WHERE destinataire_id = ? AND supprime = 1').run(req.user.id);
  const r2 = db.prepare("UPDATE messages SET supprime_sent = 2 WHERE expediteur_id = ? AND supprime_sent = 1").run(req.user.id);
  res.json({ deleted: r1.changes + r2.changes });
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

// Supprimer définitivement (reçu ou envoyé)
app.delete('/api/messages/:id/permanent', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM message_recipients WHERE message_id = ? AND destinataire_id = ?').run(req.params.id, req.user.id);
  db.prepare('UPDATE messages SET supprime_sent = 2 WHERE id = ? AND expediteur_id = ? AND supprime_sent = 1').run(req.params.id, req.user.id);
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
  const rows = db.prepare(`
    SELECT n.*,
      u.prenom || ' ' || u.nom AS auteur,
      a.titre AS activite,
      le.prenom || ' ' || le.nom AS last_editor_nom,
      eb.prenom || ' ' || eb.nom AS editing_by_nom,
      (SELECT COUNT(*) FROM note_signatures ns WHERE ns.note_id = n.id) AS nb_signatures,
      (SELECT date_signature FROM note_signatures WHERE note_id = n.id AND user_id = ?) AS date_ma_signature
    FROM meeting_notes n
    LEFT JOIN users u  ON u.id  = n.auteur_id
    LEFT JOIN users le ON le.id = n.last_editor_id
    LEFT JOIN users eb ON eb.id = n.editing_by
    LEFT JOIN activities a ON a.id = n.activity_id
    WHERE (n.auteur_id = ? OR ? IN ('admin','secretaire','tresoriere','delegue'))
    ORDER BY COALESCE(n.date_modification, n.date_reunion) DESC
  `).all(req.user.id, req.user.id, req.user.role);
  db.prepare("UPDATE meeting_notes SET editing_by=NULL, editing_since=NULL WHERE editing_since < datetime('now','-5 minutes')").run();
  res.json(rows);
});

app.post('/api/notes', authMiddleware, (req, res) => {
  const { titre, contenu, langue, date_reunion, activity_id } = req.body;
  const r = db.prepare(`INSERT INTO meeting_notes (auteur_id, titre, contenu, langue, date_reunion, activity_id, last_editor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, titre||'Sans titre', contenu||'', langue||'fr', date_reunion||'', activity_id||null, req.user.id);
  logAudit(req.user.id, 'note_created', 'note', r.lastInsertRowid, `Note créée: ${titre||'Sans titre'}`, req.ip);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/notes/:id', authMiddleware, (req, res) => {
  const note = db.prepare('SELECT verrouille FROM meeting_notes WHERE id=?').get(req.params.id);
  if (note?.verrouille) return res.status(403).json({ error: 'Note verrouillée — impossible de modifier après 2 signatures' });
  const { titre, contenu, contenu_corrige, langue, date_reunion, activity_id } = req.body;
  // Bloquer la sauvegarde de JSON brut dans le contenu
  if (contenu && /[{[,]"(qr_token|budget_prevu|paiement_requis|rabais_json|payment_status)"/.test(contenu)) {
    return res.status(400).json({ error: 'Contenu invalide — données JSON détectées' });
  }
  db.prepare(`UPDATE meeting_notes SET titre=?, contenu=?, contenu_corrige=?, langue=?,
    date_reunion=COALESCE(?,date_reunion), activity_id=?,
    date_modification=CURRENT_TIMESTAMP, last_editor_id=?, editing_by=NULL, editing_since=NULL
    WHERE id=?`)
    .run(titre||'', contenu||'', contenu_corrige||null, langue||'fr',
      date_reunion||null, activity_id||null, req.user.id, req.params.id);
  // Toute modification annule les signatures existantes
  const deleted = db.prepare('DELETE FROM note_signatures WHERE note_id=?').run(req.params.id);
  res.json({ ok: true, signatures_annulees: deleted.changes });
});

// Signer une note
app.post('/api/notes/:id/sign', authMiddleware, (req, res) => {
  const { signature_data } = req.body;
  if (!signature_data) return res.status(400).json({ error: 'Signature requise' });
  const note = db.prepare('SELECT * FROM meeting_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note introuvable' });
  if (note.verrouille) return res.status(403).json({ error: 'Note déjà verrouillée' });
  try {
    db.prepare(`INSERT OR REPLACE INTO note_signatures (note_id, user_id, signature_data, ip) VALUES (?,?,?,?)`)
      .run(note.id, req.user.id, signature_data, req.ip);
    const { cnt } = db.prepare('SELECT COUNT(*) AS cnt FROM note_signatures WHERE note_id=?').get(note.id);
    if (cnt >= 2) db.prepare('UPDATE meeting_notes SET verrouille=1 WHERE id=?').run(note.id);
    logAdmin(req.user.id, 'signature_note', `note ${note.id} — ${note.titre}`, note.id, 'note', req.ip);
    res.json({ ok: true, verrouille: cnt >= 2, nb_signatures: cnt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lister les signatures d'une note
app.get('/api/notes/:id/signatures', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT ns.*, u.prenom||' '||u.nom AS nom_signataire, u.role
    FROM note_signatures ns JOIN users u ON u.id=ns.user_id
    WHERE ns.note_id=? ORDER BY ns.date_signature`).all(req.params.id);
  res.json(rows);
});

// Télécharger une note (HTML imprimable)
app.get('/api/notes/:id/download', authMiddleware, (req, res) => {
  const n = db.prepare(`SELECT n.*, u.prenom||' '||u.nom AS auteur, a.titre AS activite
    FROM meeting_notes n LEFT JOIN users u ON u.id=n.auteur_id LEFT JOIN activities a ON a.id=n.activity_id
    WHERE n.id=?`).get(req.params.id);
  if (!n) return res.status(404).send('Note introuvable');
  const sigs = db.prepare(`SELECT ns.*, u.prenom||' '||u.nom AS nom_signataire, u.role
    FROM note_signatures ns JOIN users u ON u.id=ns.user_id WHERE ns.note_id=? ORDER BY ns.date_signature`).all(req.params.id);
  const ROLE_LABELS = { admin:'Administrateur', tresoriere:'Trésorière', secretaire:'Secrétaire', delegue:'Délégué', member:'Membre' };
  const fmt = d => { try { return new Date(d).toLocaleString('fr-CA', { timeZone:'America/Toronto', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return d||''; } };
  const siteUrl2 = process.env.SITE_URL || 'https://ahhamilton.ca';
  const html = `<!DOCTYPE html><html lang="fr">
<head><meta charset="UTF-8"><title>${n.titre||'Note de réunion'}</title>
<style>
  @page{size:8.5in 11in;margin:0}
  *{box-sizing:border-box}
  body{font-family:'Times New Roman',serif;margin:0;padding:0;color:#000;font-size:12pt;line-height:1.6;background:#fff}
  .page{width:8.5in;min-height:11in;margin:0 auto;display:flex;flex-direction:column}
  .ahh-header{border-bottom:3px solid #1a237e;padding:12px 64px 10px;display:flex;align-items:center;gap:14px}
  .ahh-header img{height:52px;width:52px;object-fit:cover;border-radius:8px;flex-shrink:0}
  .ahh-header-text{flex:1}
  .ahh-header-org{font-weight:800;font-size:12pt;color:#1a237e;letter-spacing:.3px}
  .ahh-header-sub{font-size:9pt;color:#555;margin-top:2px}
  .ahh-header-date{font-size:9pt;color:#888;text-align:right}
  .content{flex:1;padding:36px 64px;min-height:900px}
  .sig-section{border-top:2px solid #1a237e;padding-top:20px;margin-top:32px}
  .sig-section h2{color:#1a237e;font-size:13pt}
  .sig-card{display:flex;gap:20px;align-items:center;border:1px solid #ccc;border-radius:6px;padding:12px;margin-bottom:10px;page-break-inside:avoid}
  .sig-img{width:180px;height:70px;object-fit:contain;border:1px solid #ddd;border-radius:4px;background:#fff;flex-shrink:0}
  .sig-name{font-weight:bold;font-size:11pt}
  .sig-role{font-size:9pt;color:#555}
  .sig-date{font-size:9pt;color:#1a237e;margin-top:2px}
  .locked{background:#e8eaf6;color:#1a237e;border:1px solid #9fa8da;border-radius:6px;padding:8px 16px;display:inline-block;font-size:9pt;font-weight:bold;margin-bottom:8px}
  .ahh-footer{border-top:2px solid #1a237e;padding:8px 64px;display:flex;justify-content:space-between;font-size:8pt;color:#888;margin-top:auto}
  @media print{.no-print{display:none}}
</style></head>
<body>
<div class="page">
<div class="ahh-header">
  <img src="${siteUrl2}/Public/logo1.png" onerror="this.style.display='none'">
  <div class="ahh-header-text">
    <div class="ahh-header-org">Association Haïtienne de Hamilton (AHH)</div>
    <div class="ahh-header-sub">Notes de réunion officielle${n.titre ? ' — ' + n.titre : ''}</div>
  </div>
  <div class="ahh-header-date">
    ${n.date_reunion ? new Date(n.date_reunion).toLocaleDateString('fr-CA',{year:'numeric',month:'long',day:'numeric'}) : new Date().toLocaleDateString('fr-CA',{year:'numeric',month:'long',day:'numeric'})}
  </div>
</div>
<div class="content">${n.contenu||''}</div>
${sigs.length ? `
<div class="sig-section">
  ${n.verrouille ? '<div class="locked">✅ Note verrouillée — ' + sigs.length + ' signature(s)</div><br>' : ''}
  <h2>Signatures</h2>
  ${sigs.map(s => `<div class="sig-card">
    <img class="sig-img" src="${s.signature_data}" alt="Signature">
    <div>
      <div class="sig-name">${s.nom_signataire}</div>
      <div class="sig-role">${ROLE_LABELS[s.role]||s.role}</div>
      <div class="sig-date">📅 Signé le ${fmt(s.date_signature)}</div>
    </div>
  </div>`).join('')}
</div>` : ''}
<div class="ahh-footer">
  <span>Association Haïtienne de Hamilton — Hamilton, Ontario, Canada</span>
  <span>Généré le ${fmt(new Date().toISOString())} — Document officiel confidentiel</span>
</div>
</div>
<div style="text-align:center;margin:16px 0" class="no-print">
  <button onclick="window.print()" style="padding:10px 24px;background:#1a237e;color:#fff;border:none;border-radius:6px;cursor:pointer">🖨 Imprimer / Sauvegarder PDF</button>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Attestation de signature pour une note
app.get('/api/notes/:id/attestation', authMiddleware, (req, res) => {
  const n = db.prepare(`SELECT n.*, u.prenom||' '||u.nom AS auteur FROM meeting_notes n LEFT JOIN users u ON u.id=n.auteur_id WHERE n.id=?`).get(req.params.id);
  if (!n) return res.status(404).send('Note introuvable');
  const sigs = db.prepare(`SELECT ns.*, u.prenom||' '||u.nom AS nom_signataire, u.role
    FROM note_signatures ns JOIN users u ON u.id=ns.user_id WHERE ns.note_id=? ORDER BY ns.date_signature`).all(req.params.id);
  const ROLE_LABELS = { admin:'Administrateur', tresoriere:'Trésorière', secretaire:'Secrétaire', delegue:'Délégué', member:'Membre' };
  const fmt = d => { try { return new Date(d).toLocaleString('fr-CA', { timeZone:'America/Toronto', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return d||''; } };
  const html = `<!DOCTYPE html><html lang="fr">
<head><meta charset="UTF-8"><title>Attestation — ${n.titre}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;color:#222}
  .header{text-align:center;padding-bottom:24px;margin-bottom:32px;border-bottom:3px solid #1b5e20}
  .header h1{color:#1b5e20;margin:8px 0 4px;font-size:1.4rem}
  .doc-box{background:#f9f9f9;border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:28px;font-size:.9rem;line-height:1.7}
  h2{color:#1b5e20;font-size:1.1rem;border-bottom:1px solid #e0e0e0;padding-bottom:8px}
  .sig-card{border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:14px;display:flex;gap:20px;align-items:center}
  .sig-img{width:200px;height:80px;object-fit:contain;border:1px solid #ccc;border-radius:4px;background:#fff;flex-shrink:0}
  .sig-name{font-weight:bold;font-size:1rem}
  .sig-role{color:#666;font-size:.85rem}
  .sig-date{color:#1b5e20;font-size:.82rem;margin-top:4px}
  .stamp{display:inline-block;border:2px solid #1b5e20;color:#1b5e20;border-radius:6px;padding:4px 12px;font-size:.8rem;font-weight:bold;margin-top:8px}
  .footer{margin-top:40px;text-align:center;font-size:.75rem;color:#aaa;border-top:1px solid #eee;padding-top:16px}
  @media print{.no-print{display:none}}
</style></head>
<body>
<div class="header">
  <div style="font-size:2.5rem">🔏</div>
  <h1>Attestation de signature électronique</h1>
  <p>Association Haïtienne de Hamilton — ahhamilton.ca</p>
</div>
<div class="doc-box">
  <strong>Note :</strong> ${n.titre||'Sans titre'}<br>
  <strong>Auteur :</strong> ${n.auteur||'?'}<br>
  ${n.date_reunion ? `<strong>Date de réunion :</strong> ${new Date(n.date_reunion).toLocaleDateString('fr-CA',{year:'numeric',month:'long',day:'numeric'})}<br>` : ''}
  <strong>Statut :</strong> ${n.verrouille ? '🔒 Verrouillée' : '📝 Ouverte'}<br>
  <strong>Nombre de signataires :</strong> ${sigs.length}
  <br><span class="stamp">${n.verrouille ? '🔒 VERROUILLÉE' : sigs.length >= 2 ? '✅ SIGNÉ' : '⏳ EN ATTENTE'}</span>
</div>
<h2>Signatures (${sigs.length})</h2>
${sigs.length === 0 ? '<p style="color:#999;font-style:italic">Aucune signature.</p>' : sigs.map(s => `
<div class="sig-card">
  <img class="sig-img" src="${s.signature_data}" alt="Signature">
  <div>
    <div class="sig-name">${s.nom_signataire}</div>
    <div class="sig-role">${ROLE_LABELS[s.role]||s.role}</div>
    <div class="sig-date">📅 Signé le ${fmt(s.date_signature)}</div>
  </div>
</div>`).join('')}
<div class="footer">Attestation générée le ${fmt(new Date().toISOString())} — Association Haïtienne de Hamilton</div>
<div style="text-align:center;margin-top:20px" class="no-print">
  <button onclick="window.print()" style="padding:10px 24px;background:#1b5e20;color:#fff;border:none;border-radius:6px;cursor:pointer">🖨 Imprimer / PDF</button>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
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

// ── Contributions collaboratives ──────────────────────────────────────────────

// Sauvegarder ma contribution (upsert)
app.post('/api/notes/:id/contribute', authMiddleware, (req, res) => {
  const { contenu } = req.body;
  const note = db.prepare('SELECT verrouille FROM meeting_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note introuvable' });
  if (note.verrouille) return res.status(403).json({ error: 'Note verrouillée' });
  db.prepare(`INSERT OR REPLACE INTO note_contributions (note_id, user_id, contenu, derniere_frappe)
    VALUES (?,?,?,CURRENT_TIMESTAMP)`).run(req.params.id, req.user.id, contenu || '');
  res.json({ ok: true });
});

// Lire toutes les contributions actives
app.get('/api/notes/:id/contributions', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT nc.*, u.prenom||' '||u.nom AS nom, u.photo_url
    FROM note_contributions nc JOIN users u ON u.id=nc.user_id
    WHERE nc.note_id=? ORDER BY nc.derniere_frappe ASC
  `).all(req.params.id);
  res.json(rows);
});

// Fusionner toutes les contributions dans la note principale
app.post('/api/notes/:id/merge', authMiddleware, (req, res) => {
  const note = db.prepare('SELECT * FROM meeting_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note introuvable' });
  if (note.verrouille) return res.status(403).json({ error: 'Note verrouillée' });
  const contribs = db.prepare(`
    SELECT nc.*, u.prenom||' '||u.nom AS nom
    FROM note_contributions nc JOIN users u ON u.id=nc.user_id
    WHERE nc.note_id=? AND nc.contenu != '' ORDER BY nc.derniere_frappe ASC
  `).all(req.params.id);
  if (!contribs.length) return res.json({ ok: true, merged: 0 });
  const fmt = d => { try { return new Date(d).toLocaleString('fr-CA',{timeZone:'America/Toronto',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch { return d||''; } };
  const separator = `<hr style="margin:28px 0 16px;border:none;border-top:2px solid #1b5e20"><p style="color:#888;font-size:9pt;text-align:center;margin:0 0 20px">— Contributions fusionnées le ${fmt(new Date().toISOString())} —</p>`;
  const sections = contribs.map(c =>
    `<h3 style="color:#1b5e20;margin:20px 0 6px;border-bottom:1px solid #e0e0e0;padding-bottom:4px;font-family:Arial,sans-serif">✍️ ${c.nom}</h3>${c.contenu}`
  ).join('<br>');
  const merged = (note.contenu || '') + separator + sections;
  db.prepare(`UPDATE meeting_notes SET contenu=?, date_modification=CURRENT_TIMESTAMP, last_editor_id=? WHERE id=?`)
    .run(merged, req.user.id, req.params.id);
  db.prepare('DELETE FROM note_contributions WHERE note_id=?').run(req.params.id);
  db.prepare('DELETE FROM note_signatures WHERE note_id=?').run(req.params.id);
  logAdmin(req.user.id, 'note_merge', `note ${note.id} — ${contribs.length} contributions fusionnées`, note.id, 'note', req.ip);
  res.json({ ok: true, merged: contribs.length, contenu: merged });
});

// Supprimer ma contribution (quand je quitte le mode collab)
app.delete('/api/notes/:id/contribute', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM note_contributions WHERE note_id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
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

// ── Test SMTP ────────────────────────────────────────────────────────────────
app.get('/api/email/test-smtp', authMiddleware, requireRole(...COMITE_ROLES), async (req, res) => {
  const nodemailer = require('nodemailer');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const orgEmail   = user?.email_org || null;
  const orgPass    = user?.smtp_pass_org || process.env.ORG_SMTP_PASS || '';
  const smtpHost   = process.env.SMTP_HOST || '';
  const results    = [];

  if (!smtpHost) return res.json({ ok: false, results: [], error: 'SMTP_HOST non défini dans .env' });

  if (orgEmail && orgPass) {
    for (const [port, secure] of [[465, true],[587, false]]) {
      try {
        const t = nodemailer.createTransport({ host: smtpHost, port, secure,
          auth: { user: orgEmail, pass: orgPass }, tls: { rejectUnauthorized: false },
          connectionTimeout: 8000, socketTimeout: 10000 });
        await t.verify();
        results.push({ compte: orgEmail, port, secure, ok: true });
      } catch(e) {
        results.push({ compte: orgEmail, port, secure, ok: false, error: e.message });
      }
    }
  }

  // Test compte principal
  try {
    const t = nodemailer.createTransport({ host: smtpHost,
      port: parseInt(process.env.SMTP_PORT)||587, secure: parseInt(process.env.SMTP_PORT)===465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false }, connectionTimeout: 8000, socketTimeout: 10000 });
    await t.verify();
    results.push({ compte: process.env.SMTP_USER, port: parseInt(process.env.SMTP_PORT)||587, ok: true });
  } catch(e) {
    results.push({ compte: process.env.SMTP_USER, port: parseInt(process.env.SMTP_PORT)||587, ok: false, error: e.message });
  }

  const anyOk = results.some(r => r.ok);
  res.json({ ok: anyOk, results, smtpHost, orgEmail });
});

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
    const parsed = await imap.fetchEmailBody(orgEmail, orgPass, uid);
    res.json({ body: parsed.text, html: parsed.html });
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

app.get('/api/reports/finance', authMiddleware, requireRole('admin', 'tresoriere', 'secretaire'), (req, res) => {
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
  const uid = req.user.id;
  const role = req.user.role;
  const isExec = ['admin','tresoriere','secretaire','delegue'].includes(role);
  const moisCourant = new Date().toISOString().substring(0, 7);

  const stats = {
    total_membres:          db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND role='member'").get().c,
    total_activites:        db.prepare("SELECT COUNT(*) AS c FROM activities WHERE statut != 'annulee'").get().c,
    total_heures:           db.prepare("SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE statut='approuve'").get().c,
    messages_non_lus:       db.prepare("SELECT COUNT(*) AS c FROM message_recipients WHERE destinataire_id=? AND lu=0 AND supprime=0").get(uid).c,
    alertes_non_lues:       db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE destinataire_id=? AND lu=0").get(uid).c,
    // Badges pour le comité
    inscriptions_en_attente: isExec
      ? db.prepare("SELECT COUNT(*) AS c FROM pending_registrations WHERE statut='en_attente'").get().c
      : 0,
    paiements_en_attente: isExec
      ? db.prepare("SELECT COUNT(*) AS c FROM payments WHERE statut='en_attente'").get().c
      : 0,
    taches_a_faire: db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigne_a=? AND statut IN ('a_faire','en_cours')").get(uid).c,
    activites_a_venir: db.prepare("SELECT COUNT(*) AS c FROM activities WHERE statut='planifiee' AND date_debut >= date('now')").get().c,
    reunions_a_venir: isExec
      ? db.prepare("SELECT COUNT(*) AS c FROM meeting_schedule WHERE date_heure >= datetime('now')").get().c
      : 0,
    agendas_brouillon: isExec
      ? db.prepare("SELECT COUNT(*) AS c FROM agendas WHERE statut='brouillon'").get().c
      : 0,
    decisions_en_cours: isExec
      ? db.prepare("SELECT COUNT(*) AS c FROM decisions WHERE statut='en_cours'").get().c
      : 0,
    notes_actives: isExec
      ? db.prepare("SELECT COUNT(*) AS c FROM meeting_notes WHERE verrouille=0").get().c
      : 0,
    forum_non_lu: db.prepare(`SELECT COUNT(*) AS c FROM forum_posts fp
      WHERE fp.date_creation > COALESCE((SELECT MAX(date_creation) FROM forum_posts WHERE auteur_id=?), '2000-01-01')
      AND fp.auteur_id != ?`).get(uid, uid).c,
    sondages_actifs: db.prepare("SELECT COUNT(*) AS c FROM young_polls WHERE actif=1 AND (date_fin IS NULL OR date_fin >= date('now'))").get().c,
    // Badges pour les membres
    billets_a_venir: db.prepare(`SELECT COUNT(*) AS c FROM tickets t
      JOIN activities a ON a.id = t.activity_id
      WHERE t.user_id=? AND a.date_debut >= date('now')`).get(uid).c,
    cotisation_due: (() => {
      const plan = db.prepare("SELECT plan, plan_paid_month FROM users WHERE id=?").get(uid);
      if (!plan || !['bienfaiteur','partenaire'].includes(plan.plan)) return 0;
      return plan.plan_paid_month >= moisCourant ? 0 : 1;
    })(),
    badges_nouveaux: db.prepare(`SELECT COUNT(*) AS c FROM user_badges WHERE user_id=? AND date_attribution > datetime('now','-7 days')`).get(uid).c,
    // Dashboard home
    prochaines_activites: db.prepare("SELECT id, titre, date_debut, lieu, (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=activities.id) AS nb_inscrits FROM activities WHERE statut='planifiee' ORDER BY date_debut LIMIT 5").all(),
    derniers_membres: db.prepare("SELECT id, prenom, nom, date_inscription FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0) ORDER BY date_inscription DESC LIMIT 4").all(),
  };
  if (['admin','tresoriere'].includes(role)) {
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
  uploadGallery.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Photo requise' });
    await compressImage(req.file.path, 1200);
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

// GET/PUT — configuration countdown (public GET, EXEC PUT)
app.get('/api/countdown', (req, res) => {
  const cfg = {};
  try {
    const rows = db.prepare("SELECT key, value FROM site_config WHERE key LIKE 'countdown_%'").all();
    rows.forEach(r => { cfg[r.key.replace('countdown_', '')] = r.value; });
  } catch {}
  res.json({
    actif: cfg.actif === '1',
    texte: cfg.texte || '',
    date: cfg.date || '',
    auto: cfg.auto !== '0'
  });
});

app.put('/api/countdown', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const { actif, texte, date, auto } = req.body;
  const upsert = db.prepare("INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  if (actif !== undefined) upsert.run('countdown_actif', actif ? '1' : '0');
  if (texte !== undefined) upsert.run('countdown_texte', texte);
  if (date !== undefined) upsert.run('countdown_date', date);
  if (auto !== undefined) upsert.run('countdown_auto', auto ? '1' : '0');
  res.json({ ok: true });
});

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

  // Notify all committee members (internal message + alert)
  const staff = db.prepare("SELECT * FROM users WHERE role IN ('admin','tresoriere','secretaire','delegue') AND actif=1").all();
  if (staff.length) {
    const r = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?, ?, ?, 'individuel')")
      .run(staff[0].id, `[Site public] ${sujet || 'Contact'} – ${nom}`, `De: ${nom} <${email}>\n\n${message}`);
    const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?, ?)');
    staff.forEach(s => {
      ins.run(r.lastInsertRowid, s.id);
      createAlert(s.id, 'message', `📬 Nouveau message : ${sujet || '(contact)'}`, `De : ${nom} (${email})`);
    });
  }

  // Send email to each committee member + CONTACT_EMAIL + NOTIFY_EMAILS fallbacks
  const staffEmails = staff.map(s => s.email).filter(Boolean);
  const extraContact = process.env.CONTACT_EMAIL;
  const notifyEmails = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  const toList = [...new Set([...staffEmails, ...notifyEmails, ...(extraContact ? [extraContact] : [])])];
  mailer.sendContact({ nom, email, sujet, message, toList: toList.length ? toList : null })
    .catch(e => console.error('Email contact error:', e.message));

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
app.get('/api/payments', authMiddleware, requireRole('admin','tresoriere','secretaire'), (req, res) => {
  const rows = db.prepare(`SELECT p.*, u.prenom, u.nom, u.email, u.plan
    FROM payments p LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.date_soumission DESC`).all();
  res.json(rows);
});

// POST — soumettre un paiement ou don
app.post('/api/payments', authMiddleware, uploadPayment.single('proof'), (req, res) => {
  const { montant, type, mois, methode, reference, note, periodicite, nb_mois } = req.body;
  if (!montant) return res.status(400).json({ error: 'Montant requis' });
  const proof_path = req.file ? `/uploads/payments/${req.file.filename}` : null;
  const nbM = parseInt(nb_mois) || 1;
  const r = db.prepare(`INSERT INTO payments (user_id, montant, type, mois, methode, reference, proof_path, note, periodicite, nb_mois)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, parseFloat(montant), type||'mensualite', mois||'', methode||'virement', reference||'', proof_path, note||'', periodicite||'mensuel', nbM);

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

  // Marquer les cotisations comme payées (annuel = 12 mois, multi-mois = N mois, sinon 1 mois)
  const nbMois = pay.periodicite === 'annuel' ? 12 : (pay.nb_mois || 1);
  const [anneeDebut, moisDebut] = mois.split('-').map(Number);
  let derniereMois = mois;
  for (let i = 0; i < nbMois; i++) {
    const totalMois = (moisDebut - 1 + i);
    const annee = anneeDebut + Math.floor(totalMois / 12);
    const m = (totalMois % 12) + 1;
    const periode = `${annee}-${String(m).padStart(2,'0')}`;
    db.prepare("UPDATE cotisations SET statut='paye', payment_id=? WHERE user_id=? AND periode=?").run(pay.id, pay.user_id, periode);
    derniereMois = periode;
  }
  db.prepare("UPDATE users SET plan_paid_month=? WHERE id=?").run(derniereMois, pay.user_id);

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
  if (membre && membre.telephone) sendSMS(membre.telephone, `AHH: Votre ${typeLabel.toLowerCase()} de $${pay.montant} a été approuvé.`).catch(()=>{});

  logAdmin(req.user.id, 'paiement_approuve', `$${pay.montant} — user ${pay.user_id}`, pay.id, 'payment', req.ip);
  logAudit(req.user.id, 'payment_approved', 'payment', pay.id, `Paiement $${pay.montant} approuvé — user ${pay.user_id}`, req.ip);
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

app.get('/api/receipts', authMiddleware, requireRole('admin','tresoriere','secretaire'), (req, res) => {
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
  // Remplacer l'ancien reçu si existant pour ce membre + année
  const existing = db.prepare('SELECT id FROM tax_receipts WHERE user_id=? AND annee=?').get(user_id, annee);
  let recuId;
  if (existing) {
    db.prepare('UPDATE tax_receipts SET montant_total=?, genere_par=?, contenu=?, print_token=?, date_generation=CURRENT_TIMESTAMP, archived=0 WHERE id=?')
      .run(total, req.user.id, contenu, print_token, existing.id);
    recuId = existing.id;
  } else {
    recuId = db.prepare('INSERT INTO tax_receipts (user_id, annee, montant_total, genere_par, contenu, print_token) VALUES (?,?,?,?,?,?)')
      .run(user_id, annee, total, req.user.id, contenu, print_token).lastInsertRowid;
  }

  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `🧾 Votre reçu fiscal ${annee} | AHH`, contenu);
  db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, user_id);
  createAlert(user_id, 'paiement', `🧾 Reçu fiscal ${annee} disponible`, `Total: $${total.toFixed(2)}`);
  mailer.sendRecuFiscal(u, annee, total, recuId, print_token).catch(()=>{});

  res.status(201).json({ id: recuId, montant_total: total, contenu, replaced: !!existing });
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

// ══════════════════════════════════════════════════════════════════════════════
// COTISATIONS
// ══════════════════════════════════════════════════════════════════════════════

const PLAN_ANNUEL = { bienfaiteur: 100, partenaire: 200 };

// Générer les cotisations pour un mois donné (idempotent — UNIQUE constraint)
function genererCotisations(periode) {
  const [annee, mois] = periode.split('-').map(Number);
  const dateEcheance = `${periode}-15`;
  const membres = db.prepare("SELECT id, plan FROM users WHERE actif=1 AND plan IN ('bienfaiteur','partenaire') AND (phantom IS NULL OR phantom=0)").all();
  let nb = 0;
  for (const m of membres) {
    const montant = PLAN_PRIX[m.plan] || 0;
    try {
      db.prepare("INSERT OR IGNORE INTO cotisations (user_id, periode, montant_attendu, plan, date_echeance) VALUES (?,?,?,?,?)").run(m.id, periode, montant, m.plan, dateEcheance);
      nb++;
    } catch {}
  }
  return nb;
}

// GET — toutes les cotisations avec info membre
app.get('/api/cotisations', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const { periode, statut } = req.query;
  let sql = `SELECT c.*, u.prenom, u.nom, u.email, u.plan AS user_plan
    FROM cotisations c LEFT JOIN users u ON u.id = c.user_id`;
  const conds = [], params = [];
  if (periode) { conds.push("c.periode = ?"); params.push(periode); }
  if (statut)  { conds.push("c.statut = ?");  params.push(statut);  }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY c.periode DESC, u.nom ASC';
  res.json(db.prepare(sql).all(...params));
});

// GET — cotisations du membre connecté
app.get('/api/cotisations/my', authMiddleware, (req, res) => {
  res.json(db.prepare("SELECT * FROM cotisations WHERE user_id = ? ORDER BY periode DESC").all(req.user.id));
});

// GET — résumé revenus attendus vs réels par mois
app.get('/api/cotisations/summary', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const moisCourant = new Date().toISOString().substring(0,7);
  // Revenus attendus ce mois
  const attendu = db.prepare(`SELECT COALESCE(SUM(montant_attendu),0) AS total FROM cotisations WHERE periode=?`).get(moisCourant)?.total || 0;
  // Revenus reçus ce mois (paiements approuvés)
  const reel = db.prepare(`SELECT COALESCE(SUM(montant),0) AS total FROM payments WHERE statut='approuve' AND mois=?`).get(moisCourant)?.total || 0;
  // Membres en retard (cotisation en_attente + date_echeance passée)
  const today = new Date().toISOString().substring(0,10);
  const enRetard = db.prepare(`SELECT COUNT(*) AS n FROM cotisations c JOIN users u ON u.id=c.user_id WHERE c.statut='en_attente' AND c.date_echeance < ? AND c.periode=?`).get(today, moisCourant)?.n || 0;
  // Membres à jour ce mois
  const aJour = db.prepare(`SELECT COUNT(*) AS n FROM cotisations WHERE statut='paye' AND periode=?`).get(moisCourant)?.n || 0;
  // Total annuel
  const annee = new Date().getFullYear();
  const totalAnnee = db.prepare(`SELECT COALESCE(SUM(montant),0) AS total FROM payments WHERE statut='approuve' AND substr(mois,1,4)=?`).get(String(annee))?.total || 0;
  res.json({ moisCourant, attendu, reel, enRetard, aJour, totalAnnee });
});

// POST — générer manuellement les cotisations d'un mois
app.post('/api/cotisations/generate', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const periode = req.body.periode || new Date().toISOString().substring(0,7);
  const nb = genererCotisations(periode);
  res.json({ message: `Cotisations générées pour ${periode}`, nb });
});

// GET — membres en retard avec détails
app.get('/api/cotisations/retard', authMiddleware, requireRole('admin','tresoriere','secretaire','delegue'), (req, res) => {
  const moisCourant = new Date().toISOString().substring(0,7);
  const today = new Date().toISOString().substring(0,10);
  const rows = db.prepare(`
    SELECT c.*, u.prenom, u.nom, u.email, u.plan AS user_plan, u.telephone
    FROM cotisations c JOIN users u ON u.id=c.user_id
    WHERE c.statut='en_attente' AND c.periode=?
    ORDER BY u.nom ASC
  `).all(moisCourant);
  res.json(rows);
});

// PATCH — exempter un membre d'une cotisation
app.patch('/api/cotisations/:id/exempter', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  db.prepare("UPDATE cotisations SET statut='exempte' WHERE id=?").run(req.params.id);
  res.json({ message: 'Membre exempté pour cette période' });
});

// PATCH — marquer une cotisation comme payée manuellement
app.patch('/api/cotisations/:id/payer', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  db.prepare("UPDATE cotisations SET statut='paye' WHERE id=?").run(req.params.id);
  res.json({ message: 'Cotisation marquée comme payée' });
});

// GET — rapport mensuel (données pour export)
app.get('/api/payments/rapport-mensuel', authMiddleware, requireRole('admin','tresoriere','secretaire'), (req, res) => {
  const mois = req.query.mois || new Date().toISOString().substring(0,7);
  const paiements = db.prepare(`
    SELECT p.*, u.prenom, u.nom, u.email, u.plan
    FROM payments p LEFT JOIN users u ON u.id=p.user_id
    WHERE p.mois=? AND p.statut='approuve'
    ORDER BY u.nom ASC
  `).all(mois);
  const totalMensualites = paiements.filter(p=>p.type==='mensualite').reduce((s,p)=>s+p.montant,0);
  const totalDons = paiements.filter(p=>p.type==='don').reduce((s,p)=>s+p.montant,0);
  const nbMembresBienfaiteur = db.prepare("SELECT COUNT(*) AS n FROM users WHERE actif=1 AND plan='bienfaiteur'").get()?.n||0;
  const nbMembresPartenaire = db.prepare("SELECT COUNT(*) AS n FROM users WHERE actif=1 AND plan='partenaire'").get()?.n||0;
  res.json({ mois, paiements, totalMensualites, totalDons, nbMembresBienfaiteur, nbMembresPartenaire });
});

// Archiver / désarchiver un reçu
app.patch('/api/receipts/:id/archiver', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  const r = db.prepare('SELECT id, archived FROM tax_receipts WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reçu introuvable' });
  db.prepare('UPDATE tax_receipts SET archived=? WHERE id=?').run(r.archived ? 0 : 1, r.id);
  res.json({ archived: !r.archived });
});

// Supprimer un reçu
app.delete('/api/receipts/:id', authMiddleware, requireRole('admin','tresoriere'), (req, res) => {
  db.prepare('DELETE FROM tax_receipts WHERE id=?').run(req.params.id);
  res.json({ message: 'Reçu supprimé' });
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
app.post('/api/talents', authMiddleware, uploadTalent.single('photo'), async (req, res) => {
  const { nom, categorie, specialite, description, telephone, adresse, site_web, user_id } = req.body;
  const targetUserId = parseInt(user_id) || req.user.id;

  if (!can_admin(req) && !isPlanOk(targetUserId))
    return res.status(403).json({ error: 'Plan bienfaiteur ($10/mois) requis pour s\'afficher dans les talents.' });
  if (!can_admin(req)) {
    const lim = checkLimit(targetUserId, 'talents', 'talents');
    if (!lim.ok) return res.status(403).json({ error: lim.msg });
  }
  if (!nom || !categorie) return res.status(400).json({ error: 'Nom et catégorie requis' });

  if (req.file) await compressImage(req.file.path, 1200);
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
app.put('/api/talents/:id', authMiddleware, uploadTalent.single('photo'), async (req, res) => {
  const { nom, categorie, specialite, description, telephone, adresse, site_web, actif } = req.body;
  const talent = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!talent) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!can_admin(req) && talent.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });

  if (req.file) await compressImage(req.file.path, 1200);
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
app.put('/api/talents/:id/modifier', authMiddleware, uploadTalent.single('photo'), async (req, res) => {
  const { nom, categorie, specialite, description, telephone, adresse, site_web } = req.body;
  const t = db.prepare('SELECT * FROM talents WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!can_admin(req) && t.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });

  if (req.file) await compressImage(req.file.path, 1200);
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
app.post('/api/annonces', authMiddleware, uploadAnnonce.array('photos', 5), async (req, res) => {
  const { titre, description, prix, gratuit, type, categorie, telephone } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  if (!can_admin(req) && !isPlanOk(req.user.id))
    return res.status(403).json({ error: 'Plan bienfaiteur ($10/mois) requis pour publier une annonce.' });
  if (!can_admin(req)) {
    const lim = checkLimit(req.user.id, 'annonces', 'annonces');
    if (!lim.ok) return res.status(403).json({ error: lim.msg });
  }

  if (req.files && req.files.length) {
    for (const f of req.files) await compressImage(f.path, 1200);
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
app.post('/api/tickets/checkin', authMiddleware, (req, res) => {
  const { qr_data, activity_id } = req.body;
  console.log(`[CHECKIN] user=${req.user.id} qr="${qr_data}" act=${activity_id||'all'}`);

  // Vérifier autorisation : EXEC ou délégation active
  const isExec = ['admin','tresoriere','secretaire','delegue'].includes(req.user.role);
  if (!isExec) {
    const deleg = activity_id
      ? db.prepare("SELECT id FROM scan_delegations WHERE user_id=? AND actif=1 AND (activity_id IS NULL OR activity_id=?) AND (date_expiration IS NULL OR date_expiration > datetime('now'))").get(req.user.id, activity_id)
      : db.prepare("SELECT id FROM scan_delegations WHERE user_id=? AND actif=1 AND (date_expiration IS NULL OR date_expiration > datetime('now'))").get(req.user.id);
    if (!deleg) {
      db.prepare("INSERT INTO scan_logs (activity_id, scanner_id, code_scanne, resultat, details) VALUES (?,?,?,?,?)").run(activity_id||null, req.user.id, qr_data, 'invalide', 'Accès refusé');
      return res.status(403).json({ error: 'Accès refusé — vous n\'avez pas la délégation de scan pour cette activité' });
    }
  }

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
  if (!ticket) {
    // Log: introuvable
    db.prepare("INSERT INTO scan_logs (activity_id, scanner_id, code_scanne, resultat, details) VALUES (?,?,?,?,?)")
      .run(activity_id || null, req.user.id, qr_data, 'introuvable', 'QR non reconnu');
    return res.status(404).json({ error: 'Billet introuvable — QR non reconnu' });
  }

  // Vérifier statut : accepter actif OU payment_status=paid
  const isValid = ticket.statut === 'actif' || ticket.payment_status === 'paid';
  if (!isValid) {
    // Log: invalide
    db.prepare("INSERT INTO scan_logs (activity_id, scanner_id, code_scanne, resultat, details, ticket_id) VALUES (?,?,?,?,?,?)")
      .run(ticket.act_id || null, req.user.id, qr_data, 'invalide', 'Statut: ' + ticket.statut, ticket.id);
    return res.status(403).json({ error: `Billet ${ticket.statut === 'annule' ? 'annulé' : 'non activé'} (statut: ${ticket.statut})` });
  }
  if (activity_id && ticket.act_id !== parseInt(activity_id)) {
    // Log: mauvaise activité (invalide)
    db.prepare("INSERT INTO scan_logs (activity_id, scanner_id, code_scanne, resultat, details, ticket_id) VALUES (?,?,?,?,?,?)")
      .run(ticket.act_id || null, req.user.id, qr_data, 'invalide', 'Mauvaise activité: ' + ticket.activite, ticket.id);
    return res.status(409).json({ error: `Ce billet est pour l'activité : ${ticket.activite}` });
  }

  // Vérifier aussi si déjà entré via scan de carte membre
  const regAlreadyIn = ticket.user_id
    ? db.prepare('SELECT checked_in FROM activity_registrations WHERE user_id=? AND activity_id=? AND checked_in=1').get(ticket.user_id, ticket.act_id)
    : null;
  const alreadyIn = ticket.checked_in === 1 || !!regAlreadyIn;

  if (!ticket.checked_in) {
    db.prepare('UPDATE tickets SET checked_in=1, date_checkin=CURRENT_TIMESTAMP WHERE id=?').run(ticket.id);
  }
  // Check-in croisé : marquer aussi la registration du membre
  if (ticket.user_id) {
    const reg = db.prepare('SELECT id FROM activity_registrations WHERE user_id=? AND activity_id=?').get(ticket.user_id, ticket.act_id);
    if (reg) {
      db.prepare("UPDATE activity_registrations SET statut='present', checked_in=1, date_checkin=COALESCE(date_checkin,CURRENT_TIMESTAMP) WHERE user_id=? AND activity_id=?").run(ticket.user_id, ticket.act_id);
    } else {
      db.prepare("INSERT INTO activity_registrations (user_id, activity_id, statut, checked_in, date_checkin) VALUES (?,?,'present',1,CURRENT_TIMESTAMP)").run(ticket.user_id, ticket.act_id);
    }
  }

  const nomBillet = ticket.acheteur_nom || ((ticket.buyer_prenom||'') + ' ' + (ticket.buyer_nom||'')).trim();

  // Log: valide ou deja_scanne
  db.prepare("INSERT INTO scan_logs (activity_id, scanner_id, code_scanne, resultat, details, ticket_id) VALUES (?,?,?,?,?,?)")
    .run(ticket.act_id || null, req.user.id, qr_data, alreadyIn ? 'deja_scanne' : 'valide', nomBillet + (ticket.table_numero ? ' | Table ' + ticket.table_numero : ''), ticket.id);

  const actInfo = ticket.act_id ? db.prepare('SELECT date_debut, lieu FROM activities WHERE id=?').get(ticket.act_id) : {};
  res.json({
    ok: true,
    already_checked_in: alreadyIn,
    nom: nomBillet,
    table_numero: ticket.table_numero,
    activite: ticket.activite,
    vendeur_nom: ticket.vendeur_nom,
    vendu_en_ligne: !ticket.vendu_par,
    prix: ticket.prix,
    barcode: ticket.barcode_data,
    date_checkin: alreadyIn ? ticket.date_checkin : new Date().toISOString(),
    date_evenement: actInfo?.date_debut || '',
    lieu: actInfo?.lieu || ''
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

  // Billets vendus = tickets payés + inscriptions membres payées
  const billetsVendus = billets.length + inscrits.filter(r => r.paye).length;

  // Arrivés = registrations confirmées/présentes OU checked_in + tickets scannés
  const STATUTS_ARRIVES = ['present', 'confirme', 'accepte'];
  const arrivésInscrits = inscrits.filter(r => STATUTS_ARRIVES.includes(r.statut) || r.checked_in === 1).length;
  const arrivésTickets  = billets.filter(b => b.checked_in === 1).length;
  const arrivés         = arrivésInscrits + arrivésTickets;

  // Non arrivés = billets vendus - arrivés
  const nonArrivés = Math.max(0, billetsVendus - arrivés);

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
  const totalParticipants = inscrits.length + billets.length;

  res.json({
    activite: act,
    inscrits,
    billets,
    parType,
    billetsVendus,
    checkin: { arrives: arrivés, non_arrives: nonArrivés, total: totalParticipants },
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
app.get('/api/debug/payments', authMiddleware, requireRole('admin'), (req, res) => {
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

// POST — achat de billets par un membre (depuis le détail d'activité)
app.post('/api/activities/:id/acheter-billets', authMiddleware, async (req, res) => {
  const { nb_billets = 1 } = req.body;
  const actId = parseInt(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id=?').get(actId);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });
  const qty = Math.min(Math.max(parseInt(nb_billets) || 1, 1), 20);
  const prix = act.prix || 0;
  const user = req.user;
  const fullUser = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
  const qrDir = path.join(__dirname, 'uploads', 'qr');
  if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

  const tickets = [];
  for (let i = 0; i < qty; i++) {
    const ticketToken = require('crypto').randomUUID();
    let barcode = newBarcodeData();
    while (db.prepare('SELECT id FROM tickets WHERE barcode_data=?').get(barcode)) barcode = newBarcodeData();

    const r = db.prepare(`INSERT INTO tickets
      (activity_id, user_id, acheteur_nom, acheteur_email, qr_data, barcode_data, prix, methode_paiement, payment_status, statut)
      VALUES (?,?,?,?,?,?,?,'en_ligne','paid','actif')`)
      .run(actId, user.id, `${user.prenom} ${user.nom}`, fullUser?.email || '', `TICKET:${ticketToken}`, barcode, prix);

    try {
      const scanUrl = `${siteBase}/scan.html?t=${ticketToken}`;
      const qrBuf = await QRCode.toBuffer(scanUrl, { type:'png', width:400, margin:2, errorCorrectionLevel:'H', color:{ dark:'#1b5e20', light:'#ffffff' } });
      fs.writeFileSync(path.join(qrDir, `${ticketToken}.png`), qrBuf);
    } catch(e) {}

    tickets.push({ id: r.lastInsertRowid, token: ticketToken, barcode, prix });
  }

  // Envoyer les billets par courriel
  if (fullUser?.email && tickets.length) {
    const ticketListHtml = tickets.map((t, i) => `
      <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #e0e0e0">
        <div style="font-weight:700;margin-bottom:6px">Billet ${i+1} — ${(act.titre||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
        <div style="font-size:.85rem;color:#555;margin-bottom:8px">📅 ${act.date_debut || ''} · 📍 ${act.lieu || ''}</div>
        <div style="font-size:.8rem;font-family:monospace;color:#888;margin-bottom:8px">Code : ${t.barcode}</div>
        <img src="${siteBase}/uploads/qr/${t.token}.png" alt="QR" style="width:200px;height:200px"/>
        <div style="margin-top:6px"><a href="${siteBase}/ticket.html?id=${t.id}" style="color:#1b5e20;font-weight:600">Voir mon billet →</a></div>
      </div>`).join('');

    mailer.sendMail({
      to: fullUser.email,
      subject: `🎟 Vos ${qty} billet(s) — ${act.titre} | AHH`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1b5e20;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="margin:0;font-size:1.1rem">🎟 Vos billets — ${(act.titre||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</h2>
        </div>
        <div style="padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px">
          <p>Bonjour <strong>${user.prenom}</strong>,</p>
          <p>Voici vos <strong>${qty} billet(s)</strong> pour l'activité <strong>${(act.titre||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</strong>.</p>
          <p style="font-size:.9rem;color:#555">Présentez le code QR à l'entrée de l'événement.</p>
          ${ticketListHtml}
          <p style="font-size:.8rem;color:#999;margin-top:20px">Association Haïtienne de Hamilton — ${siteBase}</p>
        </div>
      </div>`
    }).catch(e => console.error('[BILLET EMAIL]', e.message));
  }

  // Alerte in-app
  createAlert(user.id, 'billet', `🎟 ${qty} billet(s) acheté(s) — ${act.titre}`, `Vérifiez votre courriel pour les codes QR.`);

  res.json({ ok: true, qty, tickets });
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

app.post('/api/young/jobs/:id/notify', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), async (req, res) => {
  const job = db.prepare('SELECT * FROM young_jobs WHERE id=? AND actif=1').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Offre introuvable' });
  const membres = db.prepare("SELECT prenom, email FROM users WHERE actif=1 AND email IS NOT NULL AND email != ''").all();
  const JOB_TYPES = { stage:'Stage', job_etudiant:'Emploi étudiant', mentorat:'Mentorat', atelier:'Atelier' };
  const loginUrl = 'https://ahhamilton.ca/dashboard/login.html';
  let ok = 0, errors = 0;
  for (const m of membres) {
    try {
      await mailer.sendMail({
        to: m.email,
        subject: `[AHH Hamilton] Nouvelles opportunités disponibles`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">
          <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:28px;text-align:center">
            <img src="https://ahhamilton.ca/Public/logo1.png" width="64" height="64" alt="AHH" style="border-radius:12px;display:block;margin:0 auto 12px"/>
            <div style="color:#fff;font-size:1.4rem;font-weight:800">AHH Hamilton</div>
            <div style="color:rgba(255,255,255,.75);font-size:.85rem;margin-top:4px">Association Haïtienne de Hamilton</div>
          </div>
          <div style="background:#fff;padding:28px">
            <p style="font-size:1rem">Bonjour ${m.prenom},</p>
            <p>De nouvelles offres d'emploi et de stages viennent d'être publiées dans votre espace membre.</p>
            <p>Connectez-vous pour les découvrir et postuler !</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${loginUrl}" style="background:#2e7d32;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.95rem;display:inline-block">Voir les opportunités →</a>
            </div>
          </div>
          <div style="background:#f9f9f9;padding:12px;text-align:center;font-size:.75rem;color:#999">
            Association Haïtienne de Hamilton · <a href="https://ahhamilton.ca" style="color:#2e7d32">ahhamilton.ca</a>
          </div>
        </div>`
      });
      ok++;
    } catch { errors++; }
  }
  res.json({ ok, errors, total: membres.length });
});

app.post('/api/young/jobs/notify-all', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), async (req, res) => {
  const membres = db.prepare("SELECT prenom, email FROM users WHERE actif=1 AND email IS NOT NULL AND email != ''").all();
  const loginUrl = 'https://ahhamilton.ca/dashboard/login.html';
  let ok = 0, errors = 0;
  for (const m of membres) {
    try {
      await mailer.sendMail({
        to: m.email,
        subject: '[AHH Hamilton] Nouvelles opportunités disponibles',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">
          <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:28px;text-align:center">
            <img src="https://ahhamilton.ca/Public/logo1.png" width="64" height="64" alt="AHH" style="border-radius:12px;display:block;margin:0 auto 12px"/>
            <div style="color:#fff;font-size:1.4rem;font-weight:800">AHH Hamilton</div>
            <div style="color:rgba(255,255,255,.75);font-size:.85rem;margin-top:4px">Association Haïtienne de Hamilton</div>
          </div>
          <div style="background:#fff;padding:28px">
            <p style="font-size:1rem">Bonjour ${m.prenom},</p>
            <p>De nouvelles offres d'emploi et de stages viennent d'être publiées dans votre espace membre.</p>
            <p>Connectez-vous pour les découvrir et postuler !</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${loginUrl}" style="background:#2e7d32;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.95rem;display:inline-block">Voir les opportunités →</a>
            </div>
          </div>
          <div style="background:#f9f9f9;padding:12px;text-align:center;font-size:.75rem;color:#999">
            Association Haïtienne de Hamilton · <a href="https://ahhamilton.ca" style="color:#2e7d32">ahhamilton.ca</a>
          </div>
        </div>`
      });
      ok++;
    } catch { errors++; }
  }
  res.json({ ok, errors, total: membres.length });
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

app.post('/api/young/trainings/:id/notify', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), async (req, res) => {
  const t = db.prepare('SELECT * FROM young_trainings WHERE id=? AND actif=1').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Formation introuvable' });
  const membres = db.prepare("SELECT prenom, email FROM users WHERE actif=1 AND email IS NOT NULL AND email != ''").all();
  const loginUrl = 'https://ahhamilton.ca/dashboard/login.html';
  let ok = 0, errors = 0;
  for (const m of membres) {
    try {
      await mailer.sendMail({
        to: m.email,
        subject: `[AHH Hamilton] Nouvelles formations disponibles`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">
          <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:28px;text-align:center">
            <img src="https://ahhamilton.ca/Public/logo1.png" width="64" height="64" alt="AHH" style="border-radius:12px;display:block;margin:0 auto 12px"/>
            <div style="color:#fff;font-size:1.4rem;font-weight:800">AHH Hamilton</div>
            <div style="color:rgba(255,255,255,.75);font-size:.85rem;margin-top:4px">Association Haïtienne de Hamilton</div>
          </div>
          <div style="background:#fff;padding:28px">
            <p style="font-size:1rem">Bonjour ${m.prenom},</p>
            <p>De nouvelles formations et ateliers viennent d'être publiés dans votre espace membre.</p>
            <p>Connectez-vous pour les découvrir et vous inscrire !</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${loginUrl}" style="background:#2e7d32;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.95rem;display:inline-block">Voir les formations →</a>
            </div>
          </div>
          <div style="background:#f9f9f9;padding:12px;text-align:center;font-size:.75rem;color:#999">
            Association Haïtienne de Hamilton · <a href="https://ahhamilton.ca" style="color:#2e7d32">ahhamilton.ca</a>
          </div>
        </div>`
      });
      ok++;
    } catch { errors++; }
  }
  res.json({ ok, errors, total: membres.length });
});

app.post('/api/young/trainings/notify-all', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), async (req, res) => {
  const membres = db.prepare("SELECT prenom, email FROM users WHERE actif=1 AND email IS NOT NULL AND email != ''").all();
  const loginUrl = 'https://ahhamilton.ca/dashboard/login.html';
  let ok = 0, errors = 0;
  for (const m of membres) {
    try {
      await mailer.sendMail({
        to: m.email,
        subject: '[AHH Hamilton] Nouvelles formations disponibles',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">
          <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:28px;text-align:center">
            <img src="https://ahhamilton.ca/Public/logo1.png" width="64" height="64" alt="AHH" style="border-radius:12px;display:block;margin:0 auto 12px"/>
            <div style="color:#fff;font-size:1.4rem;font-weight:800">AHH Hamilton</div>
            <div style="color:rgba(255,255,255,.75);font-size:.85rem;margin-top:4px">Association Haïtienne de Hamilton</div>
          </div>
          <div style="background:#fff;padding:28px">
            <p style="font-size:1rem">Bonjour ${m.prenom},</p>
            <p>De nouvelles formations et ateliers viennent d'être publiés dans votre espace membre.</p>
            <p>Connectez-vous pour les découvrir et vous inscrire !</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${loginUrl}" style="background:#2e7d32;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.95rem;display:inline-block">Voir les formations →</a>
            </div>
          </div>
          <div style="background:#f9f9f9;padding:12px;text-align:center;font-size:.75rem;color:#999">
            Association Haïtienne de Hamilton · <a href="https://ahhamilton.ca" style="color:#2e7d32">ahhamilton.ca</a>
          </div>
        </div>`
      });
      ok++;
    } catch { errors++; }
  }
  res.json({ ok, errors, total: membres.length });
});

app.get('/api/stats/connexions', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const rows = db.prepare(`SELECT id, prenom, nom, email, role, plan, nb_connexions, derniere_connexion FROM users WHERE actif=1 ORDER BY nb_connexions DESC`).all();
  res.json(rows);
});

// ── Documents officiels ──────────────────────────────────────────────────────
app.get('/api/documents', authMiddleware, (req, res) => {
  const docs = db.prepare(`
    SELECT d.*, u.prenom||' '||u.nom AS uploader,
    (SELECT COUNT(*) FROM document_signatures ds WHERE ds.document_id = d.id) AS nb_signatures,
    (SELECT date_signature FROM document_signatures WHERE document_id = d.id AND user_id = ?) AS date_ma_signature
    FROM documents d LEFT JOIN users u ON u.id=d.upload_par ORDER BY d.date_upload DESC
  `).all(req.user.id);
  res.json(docs);
});
app.get('/api/documents/:id/attestation', authMiddleware, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).send('Document introuvable');
  const sigs = db.prepare(`
    SELECT ds.*, u.prenom||' '||u.nom AS nom_signataire, u.role
    FROM document_signatures ds JOIN users u ON u.id=ds.user_id
    WHERE ds.document_id=? ORDER BY ds.date_signature
  `).all(req.params.id);
  const fmt = d => { try { return new Date(d).toLocaleString('fr-CA', { timeZone:'America/Toronto', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return d||''; } };
  const fmtDate = d => { try { return new Date(d).toLocaleDateString('fr-CA', { timeZone:'America/Toronto', year:'numeric', month:'long', day:'numeric' }); } catch { return d||''; } };
  const ROLE_LABELS = { admin:'Administrateur', tresoriere:'Trésorière', secretaire:'Secrétaire', delegue:'Délégué', member:'Membre' };
  const html = `<!DOCTYPE html><html lang="fr">
<head><meta charset="UTF-8"><title>Attestation — ${doc.nom}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;color:#222}
  .header{text-align:center;padding-bottom:24px;margin-bottom:32px;border-bottom:3px solid #1b5e20}
  .header h1{color:#1b5e20;margin:8px 0 4px;font-size:1.4rem}
  .header p{color:#555;margin:0;font-size:.9rem}
  .doc-box{background:#f9f9f9;border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:28px;font-size:.9rem;line-height:1.7}
  .doc-box strong{color:#1b5e20}
  h2{color:#1b5e20;font-size:1.1rem;border-bottom:1px solid #e0e0e0;padding-bottom:8px}
  .sig-card{border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:14px;display:flex;gap:20px;align-items:center;page-break-inside:avoid}
  .sig-img{width:200px;height:80px;object-fit:contain;border:1px solid #ccc;border-radius:4px;background:#fff;flex-shrink:0}
  .sig-name{font-weight:bold;font-size:1rem}
  .sig-role{color:#666;font-size:.85rem}
  .sig-date{color:#1b5e20;font-size:.82rem;margin-top:4px}
  .none{color:#999;font-style:italic}
  .footer{margin-top:40px;text-align:center;font-size:.75rem;color:#aaa;border-top:1px solid #eee;padding-top:16px}
  .stamp{display:inline-block;border:2px solid #1b5e20;color:#1b5e20;border-radius:6px;padding:4px 12px;font-size:.8rem;font-weight:bold;margin-top:8px}
  @media print{.no-print{display:none}}
</style></head>
<body>
<div class="header">
  <div style="font-size:2.5rem">🔏</div>
  <h1>Attestation de signature électronique</h1>
  <p>Association Haïtienne de Hamilton — ahhamilton.ca</p>
</div>
<div class="doc-box">
  <strong>Document :</strong> ${doc.nom}<br>
  ${doc.description ? `<strong>Description :</strong> ${doc.description}<br>` : ''}
  <strong>Catégorie :</strong> ${({proces_verbaux:'Procès-verbaux',statuts:'Statuts & Règlements',formulaires:'Formulaires officiels',rapports:'Rapports annuels',autre:'Autres documents'})[doc.categorie]||doc.categorie}<br>
  <strong>Ajouté le :</strong> ${fmtDate(doc.date_upload)}<br>
  <strong>Nombre de signataires :</strong> ${sigs.length}
  <br><span class="stamp">${sigs.length > 0 ? '✅ SIGNÉ' : '⏳ EN ATTENTE DE SIGNATURE'}</span>
</div>
<h2>Signatures (${sigs.length})</h2>
${sigs.length === 0 ? '<p class="none">Aucune signature enregistrée pour ce document.</p>' : sigs.map((s,i) => `
<div class="sig-card">
  <img class="sig-img" src="${s.signature_data}" alt="Signature">
  <div>
    <div class="sig-name">${s.nom_signataire}</div>
    <div class="sig-role">${ROLE_LABELS[s.role]||s.role}</div>
    <div class="sig-date">📅 Signé le ${fmt(s.date_signature)}</div>
  </div>
</div>`).join('')}
<div class="footer">
  Attestation générée le ${fmt(new Date().toISOString())} — Association Haïtienne de Hamilton
  <br>Ce document constitue la preuve des signatures électroniques collectées sur la plateforme AHH.
</div>
<div style="text-align:center;margin-top:20px" class="no-print">
  <button onclick="window.print()" style="padding:10px 24px;background:#1b5e20;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.9rem">🖨 Imprimer / Enregistrer PDF</button>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
app.post('/api/documents', authMiddleware, requireRole('admin','secretaire'), uploadDoc.single('fichier'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  const { nom, description, categorie } = req.body;
  const r = db.prepare(`INSERT INTO documents (nom,description,categorie,fichier_path,fichier_nom,taille,mime_type,upload_par) VALUES (?,?,?,?,?,?,?,?)`)
    .run(nom||req.file.originalname, description||'', categorie||'autre', req.file.path, req.file.originalname, req.file.size, req.file.mimetype, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});
app.get('/api/documents/:id/download', authMiddleware, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Introuvable' });
  res.download(doc.fichier_path, doc.fichier_nom);
});
app.delete('/api/documents/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Introuvable' });
  try { fs.unlinkSync(doc.fichier_path); } catch {}
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Cotisation en ligne (Stripe Checkout) ────────────────────────────────────
app.post('/api/cotisations/checkout', authMiddleware, async (req, res) => {
  const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré sur ce serveur' });
  const PRIX = { bienfaiteur: { monthly:1000, annual:10000 }, partenaire: { monthly:2000, annual:20000 } };
  const plan = req.user.plan || 'gratuit';
  const prixPlan = PRIX[plan] || PRIX.bienfaiteur;
  const nbMois = parseInt(req.body.nb_mois) || 1;
  const isAnnuel = nbMois === 12;
  const montantCents = isAnnuel ? prixPlan.annual : prixPlan.monthly * nbMois;
  const planLabel = plan === 'partenaire' ? 'Partenaire' : plan === 'bienfaiteur' ? 'Bienfaiteur' : 'Cotisation';
  const periode = new Date().toISOString().substring(0, 7);
  const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
  try {
    const stripe = Stripe(stripeKey);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [{ price_data: {
        currency: 'cad',
        product_data: {
          name: `Cotisation AHH — ${planLabel}`,
          description: isAnnuel ? 'Année complète (2 mois offerts)' : `${nbMois} mois`
        },
        unit_amount: montantCents
      }, quantity: 1 }],
      metadata: { type:'cotisation', user_id:String(req.user.id), plan, periode, nb_mois:String(nbMois), periodicite: isAnnuel ? 'annuel' : 'mensuel' },
      success_url: `${siteUrl}/dashboard/app.html?cotis=ok`,
      cancel_url:  `${siteUrl}/dashboard/app.html?cotis=cancel`,
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// Cron quotidien à 9h — génération cotisations le 15 + rappels j1/j22/dernier
cron.schedule('0 9 * * *', async () => {
  try {
    const now = new Date();
    const jour = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const moisCourant = now.toISOString().substring(0,7);

    if (jour === 15) {
      genererCotisations(moisCourant);
      console.log(`[CRON] Cotisations générées pour ${moisCourant}`);
    }

    const isRappelDay = [1, 22, 24].includes(jour) || jour === daysInMonth;
    if (isRappelDay) {
      const retards = db.prepare(`
        SELECT u.* FROM users u
        WHERE u.actif=1 AND u.plan IN ('bienfaiteur','partenaire')
        AND (u.phantom IS NULL OR u.phantom=0)
        AND NOT EXISTS (
          SELECT 1 FROM payments WHERE user_id=u.id AND statut='approuve' AND mois=?
        )
      `).all(moisCourant);

      const joursRestants = jour === 1 ? 30 : jour === 24 ? 7 : 1;
      for (const u of retards) {
        try {
          const montantCents = (PLAN_PRIX[u.plan] || 0) * 100;
          await mailer.sendRappelExpiration(u, joursRestants, montantCents, moisCourant);
          console.log(`[RAPPEL-${joursRestants}J] ${u.email}`);
        } catch(e) { console.error('[RAPPEL]', e.message); }
      }
    }
  } catch(e) { console.error('[CRON]', e.message); }
});

// ── Anniversaires — cron 8h Toronto ──────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
    const parts = d.split('-');
    const mois = parseInt(parts[1]);
    const jour = parseInt(parts[2]);
    const annee = parseInt(parts[0]);

    const membres = db.prepare(`
      SELECT * FROM users
      WHERE actif=1 AND (phantom IS NULL OR phantom=0)
      AND date_naissance IS NOT NULL AND date_naissance != ''
      AND CAST(strftime('%m', date_naissance) AS INTEGER) = ?
      AND CAST(strftime('%d', date_naissance) AS INTEGER) = ?
      AND (birthday_notif_year IS NULL OR birthday_notif_year < ?)
    `).all(mois, jour, annee);

    if (!membres.length) return;

    const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
    const expediteurId = admin?.id || 1;

    for (const u of membres) {
      try {
        // Email externe
        await mailer.sendAnniversaire(u);

        // Message interne
        const sujet = `🎂 Joyeux anniversaire, ${u.prenom} !`;
        const contenu = `Bonjour ${u.prenom},\n\nToute l'équipe de l'Association Haïtienne de Hamilton vous souhaite un très joyeux anniversaire ! 🎉🎂\n\nQue cette nouvelle année vous apporte santé, bonheur et succès.\n\nAvec toute notre affection,\nLe Comité de l'AHH`;
        const msg = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
          .run(expediteurId, sujet, contenu);
        db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msg.lastInsertRowid, u.id);

        // Marquer comme envoyé pour cette année
        db.prepare('UPDATE users SET birthday_notif_year=? WHERE id=?').run(annee, u.id);

        console.log(`[ANNIVERSAIRE] Souhaits envoyés → ${u.prenom} ${u.nom} (${u.email})`);
      } catch(e) { console.error(`[ANNIVERSAIRE] Erreur pour ${u.email}:`, e.message); }
    }
  } catch(e) { console.error('[CRON-ANNIVERSAIRE]', e.message); }
}, { timezone: 'America/Toronto' });

// ── Backup quotidien DB à 2h du matin ────────────────────────────────────────
cron.schedule('0 2 * * *', () => {
  try {
    const dbSrc = process.env.DB_PATH || path.join(process.env.LOCALAPPDATA || process.env.HOME || __dirname, 'ahh-hamilton', 'ahh.db');
    const backupDir = path.join(path.dirname(dbSrc), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const date = new Date().toISOString().substring(0, 10);
    const dst = path.join(backupDir, `ahh_${date}.db`);
    fs.copyFileSync(dbSrc, dst);
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('ahh_') && f.endsWith('.db')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(backupDir, files.shift()));
    console.log(`[BACKUP] ${dst}`);
  } catch(e) { console.error('[BACKUP ERROR]', e.message); }
});

// Rapport mensuel automatique (1er du mois à 8h)
cron.schedule('0 8 1 * *', async () => {
  try {
    const now = new Date();
    const mois = now.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' });
    const moisPrec = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const debut = moisPrec.toISOString().slice(0, 7) + '-01';
    const fin = now.toISOString().slice(0, 10);

    const stats = {
      nouveaux_membres: db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND date_inscription BETWEEN ? AND ?").get(debut, fin).c,
      total_membres: db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0)").get().c,
      activites: db.prepare("SELECT COUNT(*) AS c FROM activities WHERE date_creation BETWEEN ? AND ?").get(debut, fin).c,
      paiements: db.prepare("SELECT COALESCE(SUM(montant),0) AS t FROM payments WHERE statut='approuve' AND date_soumission BETWEEN ? AND ?").get(debut, fin).t,
      benevoles: db.prepare("SELECT COALESCE(SUM(heures),0) AS t FROM volunteer_hours WHERE statut='approuve' AND date_service BETWEEN ? AND ?").get(debut, fin).t,
    };

    const admins = db.prepare("SELECT email FROM users WHERE role IN ('admin','tresoriere','secretaire') AND actif=1").all();
    const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';

    for (const a of admins) {
      await mailer.sendMail({
        to: a.email,
        subject: '📊 Rapport mensuel AHH — ' + mois,
        html: '<div style="font-family:Arial;max-width:600px;margin:0 auto"><div style="background:#1b5e20;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0"><h2 style="margin:0">📊 Rapport mensuel — ' + mois + '</h2></div><div style="padding:20px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px"><table style="width:100%;border-collapse:collapse"><tr><td style="padding:12px;border-bottom:1px solid #eee;font-weight:700">Nouveaux membres</td><td style="padding:12px;border-bottom:1px solid #eee;text-align:right;font-size:1.2rem;color:#1b5e20">' + stats.nouveaux_membres + '</td></tr><tr><td style="padding:12px;border-bottom:1px solid #eee;font-weight:700">Total membres actifs</td><td style="padding:12px;border-bottom:1px solid #eee;text-align:right;font-size:1.2rem">' + stats.total_membres + '</td></tr><tr><td style="padding:12px;border-bottom:1px solid #eee;font-weight:700">Activités créées</td><td style="padding:12px;border-bottom:1px solid #eee;text-align:right;font-size:1.2rem">' + stats.activites + '</td></tr><tr><td style="padding:12px;border-bottom:1px solid #eee;font-weight:700">Revenus (paiements)</td><td style="padding:12px;border-bottom:1px solid #eee;text-align:right;font-size:1.2rem;color:#1b5e20">$' + stats.paiements.toFixed(2) + '</td></tr><tr><td style="padding:12px;font-weight:700">Heures bénévolat</td><td style="padding:12px;text-align:right;font-size:1.2rem">' + stats.benevoles + 'h</td></tr></table><div style="margin-top:20px;text-align:center"><a href="' + siteUrl + '/dashboard/app.html" style="display:inline-block;background:#1b5e20;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Voir le tableau de bord →</a></div></div></div>'
      }).catch(function(e) { console.error('[RAPPORT]', e.message); });
    }
    console.log('[RAPPORT MENSUEL] Envoyé à ' + admins.length + ' admin(s)');
  } catch(e) { console.error('[RAPPORT MENSUEL]', e.message); }
}, { timezone: 'America/Toronto' });

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

app.post('/api/newsletter/subscribe', async (req, res) => {
  const { email, prenom } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Courriel invalide' });
  }
  try {
    db.prepare('INSERT OR IGNORE INTO newsletter_subscribers (email, prenom) VALUES (?,?)')
      .run(email.trim().toLowerCase(), (prenom || '').trim());
    res.json({ ok: true });
    // Courriel de confirmation (non-bloquant)
    const prenom_ = (prenom || '').trim();
    const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
    mailer.sendMail({
      to: email.trim().toLowerCase(),
      subject: 'Abonnement confirmé — Nouvelles de l\'AHH Hamilton',
      html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/></head><body style="font-family:'Segoe UI',Arial,sans-serif;background:#f4f7f4;margin:0;padding:0">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(27,94,32,.1)">
  <div style="background:linear-gradient(135deg,#003F87,#D21034);padding:28px 32px;text-align:center">
    <img src="${siteUrl}/Public/logo1.png" alt="AHH" style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:2px solid rgba(255,255,255,.3)"/>
    <h1 style="color:#fff;font-size:1.15rem;font-weight:700;margin:10px 0 0">Association Haïtienne de Hamilton</h1>
  </div>
  <div style="padding:32px">
    <h2 style="color:#1b5e20;font-size:1.1rem;margin:0 0 18px">Abonnement confirmé !</h2>
    <p style="color:#3a3a3a;font-size:.9rem;line-height:1.7;margin:0 0 14px">
      Bonjour${prenom_ ? ' <strong>' + prenom_ + '</strong>' : ''},
    </p>
    <p style="color:#3a3a3a;font-size:.9rem;line-height:1.7;margin:0 0 14px">
      Merci de vous être abonné aux nouvelles de l'<strong>Association Haïtienne de Hamilton</strong> !
      Vous recevrez désormais nos annonces, invitations et actualités communautaires.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,#003F87,#D21034);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem">
        Visiter notre site
      </a>
    </div>
    <hr style="border:none;border-top:1px solid #e8f5e9;margin:20px 0"/>
    <p style="font-size:.78rem;color:#999;text-align:center">
      Pour vous désabonner, répondez à ce courriel en indiquant « désabonnement ».<br/>
      © 2026 Association Haïtienne de Hamilton
    </p>
  </div>
</div>
</body></html>`
    }).catch(e => console.error('[newsletter/subscribe] email confirmation:', e.message));
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/newsletter/subscribers', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  res.json(db.prepare('SELECT * FROM newsletter_subscribers WHERE actif=1 ORDER BY date_inscription DESC').all());
});

app.delete('/api/newsletter/subscribers/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  db.prepare('UPDATE newsletter_subscribers SET actif=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/newsletter/subscribers/export', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const rows = db.prepare('SELECT prenom, email, date_inscription FROM newsletter_subscribers WHERE actif=1 ORDER BY date_inscription DESC').all();
  const csv = 'Prénom,Courriel,Date inscription\n' +
    rows.map(r => `"${(r.prenom||'').replace(/"/g,'""')}","${r.email}","${r.date_inscription}"`).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="abonnes-newsletter.csv"');
  res.send('﻿' + csv);
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
    SELECT id, prenom, nom, email, plan, role, date_inscription, photo_url,
           carte_photo_approuvee, carte_notif_renouv
    FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0)
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

// Upload photo membre depuis le scanner (comité prend la photo)
app.post('/api/admin/cartes/:id/photo', authMiddleware, requireRole(...CARTE_ROLES), uploadProfile.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Photo requise' });
  await compressImage(req.file.path, 1200);
  const photoUrl = `/uploads/profiles/${req.file.filename}`;
  db.prepare('UPDATE users SET photo_url=?, carte_photo_approuvee=1 WHERE id=?').run(photoUrl, req.params.id);
  res.json({ ok: true, photo_url: photoUrl });
});

app.post('/api/admin/cartes/:id/renouveler', authMiddleware, requireRole(...CARTE_ROLES), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.prepare('UPDATE users SET date_inscription=?, carte_notif_renouv=0 WHERE id=?').run(today, req.params.id);
  const u = db.prepare('SELECT prenom, nom FROM users WHERE id=?').get(req.params.id);
  createAlert(req.user.id, 'carte', `🪪 Carte renouvelée : ${u.prenom} ${u.nom}`, `Expire maintenant le ${carteExpiration(today)}`);
  res.json({ ok: true, expiration: carteExpiration(today) });
});

// Scanner QR carte — chercher un membre (EXEC + membres délégués type cartes/tous)
app.get('/api/carte-scan/:qr', authMiddleware, (req, res) => {
  const isExec = CARTE_ROLES.includes(req.user.role);
  if (!isExec) {
    const deleg = db.prepare("SELECT id FROM scan_delegations WHERE user_id=? AND actif=1 AND type IN ('cartes','tous') AND (date_expiration IS NULL OR date_expiration > datetime('now'))").get(req.user.id);
    if (!deleg) return res.status(403).json({ error: 'Accès refusé — pas de délégation de scan cartes' });
  }
  const raw = decodeURIComponent(req.params.qr);
  let userId = null;

  // Format 1 : AHH-00001-referralcode (format standard carte dashboard)
  const parts = raw.split('-');
  if (parts[0] === 'AHH' && parts[1]) userId = parseInt(parts[1]);

  // Format 2 : URL contenant ?id=X ou &id=X (carte.html / ancien format)
  if (!userId) {
    const m = raw.match(/[?&]id=(\d+)/);
    if (m) userId = parseInt(m[1]);
  }

  if (!userId || isNaN(userId)) return res.status(404).json({ error: 'QR invalide' });

  const member = db.prepare(`SELECT id, prenom, nom, email, role, plan, photo_url, carte_photo_approuvee, date_inscription, actif
    FROM users WHERE id=?`).get(userId);
  if (!member) return res.status(404).json({ error: 'Membre introuvable' });
  if (!member.actif) return res.status(403).json({ error: 'Compte désactivé' });

  const expiration = carteExpiration(member.date_inscription);
  const expired = expiration ? new Date() > new Date(expiration) : false;
  const carteValide = !expired && member.carte_photo_approuvee === 1 && !!member.photo_url;
  const isExecMember = CARTE_ROLES.includes(member.role);

  const activities = db.prepare(`
    SELECT a.id, a.titre, a.date_debut, a.lieu, a.prix, a.paiement_requis,
      (SELECT statut FROM activity_registrations WHERE activity_id=a.id AND user_id=? LIMIT 1) AS reg_statut,
      (SELECT checked_in FROM activity_registrations WHERE activity_id=a.id AND user_id=? LIMIT 1) AS reg_checked_in,
      (SELECT COUNT(*) FROM tickets WHERE activity_id=a.id AND (user_id=? OR acheteur_email=?) AND payment_status='paid' AND statut='actif') AS nb_billets,
      (SELECT COUNT(*) FROM tickets WHERE activity_id=a.id AND (user_id=? OR acheteur_email=?) AND payment_status='paid' AND statut='actif' AND checked_in=0) AS billets_non_utilises
    FROM activities a WHERE a.statut IN ('planifiee','en_cours') ORDER BY a.date_debut LIMIT 40
  `).all(userId, userId, userId, member.email, userId, member.email);

  res.json({
    member: { ...member, expiration, expired, carte_valide: carteValide, is_comite: isExecMember },
    activities
  });
});

// Marquer présence via scanner carte
app.post('/api/carte-scan/presencer', authMiddleware, (req, res) => {
  const scannerIsExec = CARTE_ROLES.includes(req.user.role);
  if (!scannerIsExec) {
    const deleg = db.prepare("SELECT id FROM scan_delegations WHERE user_id=? AND actif=1 AND type IN ('cartes','tous') AND (date_expiration IS NULL OR date_expiration > datetime('now'))").get(req.user.id);
    if (!deleg) return res.status(403).json({ error: 'Accès refusé' });
  }
  const { user_id, activity_id, nb_entrees } = req.body;
  if (!user_id || !activity_id) return res.status(400).json({ error: 'Paramètres manquants' });

  const act = db.prepare('SELECT * FROM activities WHERE id=?').get(activity_id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  const scannedUser = db.prepare('SELECT id, role, prenom, nom, email, date_inscription, carte_photo_approuvee, photo_url FROM users WHERE id=?').get(user_id);
  if (!scannedUser) return res.status(404).json({ error: 'Membre introuvable' });

  const scannedIsExec = CARTE_ROLES.includes(scannedUser.role);

  // Vérifier validité de la carte (sauf comité)
  if (!scannedIsExec) {
    const exp = carteExpiration(scannedUser.date_inscription);
    const carteExpired = exp ? new Date() > new Date(exp) : false;
    if (carteExpired) {
      return res.status(403).json({
        error: 'Carte expirée',
        detail: `La carte de ${scannedUser.prenom} ${scannedUser.nom} est expirée depuis le ${exp}. Renouvellement requis.`
      });
    }
  }

  // Chercher TOUS les billets du membre pour cette activité
  const billets = db.prepare("SELECT * FROM tickets WHERE activity_id=? AND (user_id=? OR acheteur_email=?) AND payment_status='paid' AND statut='actif' ORDER BY checked_in ASC, id ASC")
    .all(activity_id, user_id, scannedUser.email);
  const billetsNonUtilises = billets.filter(b => !b.checked_in);

  // Activité payante : vérifier billet ou comité
  if (act.paiement_requis && act.prix > 0 && !scannedIsExec && billets.length === 0) {
    return res.status(403).json({
      error: 'Pas de billet — activité payante',
      detail: `${scannedUser.prenom} ${scannedUser.nom} n'a pas de billet pour cette activité (${act.prix.toFixed(2)} $). Achat requis.`
    });
  }

  // Vérifier si le membre est déjà entré
  const existingReg = db.prepare('SELECT * FROM activity_registrations WHERE user_id=? AND activity_id=?').get(user_id, activity_id);
  const regDejaPresent = existingReg?.checked_in === 1;

  // Nombre d'entrées à marquer (1 pour le membre, + accompagnateurs via billets supplémentaires)
  const entreesVoulues = Math.min(parseInt(nb_entrees) || 1, billetsNonUtilises.length || 1);

  // Check-in croisé : marquer les billets non utilisés
  let billetsCheckedIn = 0;
  for (let i = 0; i < entreesVoulues && i < billetsNonUtilises.length; i++) {
    db.prepare('UPDATE tickets SET checked_in=1, date_checkin=CURRENT_TIMESTAMP WHERE id=?').run(billetsNonUtilises[i].id);
    billetsCheckedIn++;
  }

  // Marquer présence du membre
  const statut = scannedIsExec ? 'present' : 'confirme';
  if (existingReg) {
    db.prepare('UPDATE activity_registrations SET statut=?, checked_in=1, date_checkin=COALESCE(date_checkin,CURRENT_TIMESTAMP) WHERE user_id=? AND activity_id=?')
      .run(statut, user_id, activity_id);
  } else {
    db.prepare("INSERT INTO activity_registrations (user_id, activity_id, statut, checked_in, date_checkin) VALUES (?,?,?,1,CURRENT_TIMESTAMP)")
      .run(user_id, activity_id, statut);
  }

  const totalBillets = billets.length;
  const restants = billetsNonUtilises.length - billetsCheckedIn;
  const alreadyIn = regDejaPresent && billetsNonUtilises.length === 0;

  let message;
  if (alreadyIn) {
    message = `🔄 ${scannedUser.prenom} ${scannedUser.nom} — Déjà entré(e), aucun billet restant`;
  } else if (scannedIsExec) {
    message = `✅ ${scannedUser.prenom} ${scannedUser.nom} — Comité (entrée VIP)`;
  } else if (totalBillets > 1) {
    message = `✅ ${scannedUser.prenom} ${scannedUser.nom} — ${billetsCheckedIn} entrée(s) validée(s), ${restants} billet(s) restant(s) sur ${totalBillets}`;
  } else {
    message = `✅ ${scannedUser.prenom} ${scannedUser.nom} — Présence confirmée`;
  }

  res.json({
    ok: true,
    already_in: alreadyIn,
    vip: scannedIsExec,
    total_billets: totalBillets,
    billets_utilises: totalBillets - restants,
    billets_restants: restants,
    message
  });
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
  const u = db.prepare('SELECT id, prenom, nom, email, telephone, plan, role, date_inscription, photo_url, carte_photo_approuvee, actif FROM users WHERE id=?').get(targetId);
  if (!u) return res.status(404).json({ error: 'Membre introuvable' });
  res.json(u);
});

// ── Anniversaires du jour (public) ────────────────────────────────────────────
app.get('/api/public/anniversaires', (req, res) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  const parts = d.split('-');
  const mois = parseInt(parts[1]);
  const jour = parseInt(parts[2]);
  const rows = db.prepare(`
    SELECT prenom, SUBSTR(nom,1,1) AS nom_initial, photo_url
    FROM users
    WHERE actif=1 AND (phantom IS NULL OR phantom=0)
    AND date_naissance IS NOT NULL AND date_naissance != ''
    AND CAST(strftime('%m', date_naissance) AS INTEGER) = ?
    AND CAST(strftime('%d', date_naissance) AS INTEGER) = ?
  `).all(mois, jour);
  res.json(rows);
});

// ── Sponsors / Commanditaires ─────────────────────────────────────────────────
const sponsorStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'sponsors');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `sponsor_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadSponsor = multer({ storage: sponsorStorage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use('/uploads/sponsors', express.static(path.join(__dirname, 'uploads', 'sponsors')));

app.get('/api/sponsors', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM sponsors WHERE actif=1 ORDER BY ordre ASC, date_creation ASC').all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sponsors/all', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM sponsors ORDER BY ordre ASC, date_creation DESC').all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sponsors', authMiddleware, requireRole('admin','secretaire'), uploadSponsor.single('photo'), (req, res) => {
  try {
    const { nom, description, site_web, categorie } = req.body;
    if (!nom) return res.status(400).json({ error: 'Nom requis' });
    const photo_url = req.file ? `/uploads/sponsors/${req.file.filename}` : null;
    const maxOrdre = db.prepare('SELECT COALESCE(MAX(ordre),0) AS m FROM sponsors').get().m;
    const r = db.prepare('INSERT INTO sponsors (nom, description, site_web, photo_url, categorie, cree_par, ordre) VALUES (?,?,?,?,?,?,?)')
      .run(nom, description||'', site_web||'', photo_url, categorie||'or', req.user.id, maxOrdre + 1);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sponsors/:id', authMiddleware, requireRole('admin','secretaire'), uploadSponsor.single('photo'), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM sponsors WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sponsor introuvable' });
    const { nom, description, site_web, categorie, actif, ordre } = req.body;
    const photo_url = req.file ? `/uploads/sponsors/${req.file.filename}` : existing.photo_url;
    db.prepare('UPDATE sponsors SET nom=?, description=?, site_web=?, photo_url=?, categorie=?, actif=?, ordre=? WHERE id=?')
      .run(nom||existing.nom, description!=null?description:existing.description, site_web!=null?site_web:existing.site_web,
           photo_url, categorie||existing.categorie,
           actif!=null?parseInt(actif):existing.actif, ordre!=null?parseInt(ordre):existing.ordre, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sponsors/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  try {
    db.prepare('DELETE FROM sponsors WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/sponsors/:id/ordre', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  try {
    const { direction } = req.body;
    const current = db.prepare('SELECT * FROM sponsors WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Introuvable' });
    const target = direction === 'up'
      ? db.prepare('SELECT * FROM sponsors WHERE ordre < ? ORDER BY ordre DESC LIMIT 1').get(current.ordre)
      : db.prepare('SELECT * FROM sponsors WHERE ordre > ? ORDER BY ordre ASC LIMIT 1').get(current.ordre);
    if (target) {
      db.prepare('UPDATE sponsors SET ordre=? WHERE id=?').run(target.ordre, current.id);
      db.prepare('UPDATE sponsors SET ordre=? WHERE id=?').run(current.ordre, target.id);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ══════════════════════════════════════════════════════════════════════════════
// NOUVELLES FONCTIONNALITÉS
// ══════════════════════════════════════════════════════════════════════════════

// ── Feature 5 : Export CSV ────────────────────────────────────────────────
function toCSV(rows, cols) {
  const header = cols.map(c => `"${c.label}"`).join(',');
  const lines = rows.map(r => cols.map(c => {
    const v = r[c.key] ?? '';
    return `"${String(v).replace(/"/g,'""')}"`;
  }).join(','));
  return [header, ...lines].join('\n');
}

app.get('/api/export/membres.csv', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const rows = db.prepare(`SELECT prenom,nom,email,telephone,role,plan,actif,
    date_inscription FROM users WHERE (phantom IS NULL OR phantom=0) ORDER BY nom`).all();
  const csv = toCSV(rows, [
    {key:'prenom',label:'Prénom'},{key:'nom',label:'Nom'},{key:'email',label:'Courriel'},
    {key:'telephone',label:'Téléphone'},{key:'role',label:'Rôle'},{key:'plan',label:'Plan'},
    {key:'actif',label:'Actif'},{key:'date_inscription',label:"Date d'inscription"}
  ]);
  logAdmin(req.user.id, 'export_csv', 'membres', null, 'export', req.ip);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="membres-ahh.csv"');
  res.send('﻿' + csv);
});

app.get('/api/export/paiements.csv', authMiddleware, requireRole('admin','tresoriere','secretaire'), (req, res) => {
  const rows = db.prepare(`SELECT p.id, u.prenom, u.nom, u.email, p.montant, p.type, p.mois,
    p.methode, p.reference, p.statut, p.date_soumission
    FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.date_soumission DESC`).all();
  const csv = toCSV(rows, [
    {key:'id',label:'ID'},{key:'prenom',label:'Prénom'},{key:'nom',label:'Nom'},
    {key:'email',label:'Courriel'},{key:'montant',label:'Montant ($)'},
    {key:'type',label:'Type'},{key:'mois',label:'Mois'},{key:'methode',label:'Méthode'},
    {key:'reference',label:'Référence'},{key:'statut',label:'Statut'},
    {key:'date_soumission',label:'Date soumission'}
  ]);
  logAdmin(req.user.id, 'export_csv', 'paiements', null, 'export', req.ip);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="paiements-ahh.csv"');
  res.send('﻿' + csv);
});

// ── Feature 6 : Présences événements ─────────────────────────────────────
app.get('/api/activities/:id/presences', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT ar.*, u.prenom, u.nom, u.email, u.photo_url
    FROM activity_registrations ar JOIN users u ON u.id=ar.user_id
    WHERE ar.activity_id=? ORDER BY u.nom`).all(req.params.id);
  res.json(rows);
});

app.patch('/api/activities/:id/presences/:userId/checkin', authMiddleware, requireRole('admin','secretaire','delegue'), (req, res) => {
  const { present } = req.body; // true/false
  const now = present ? new Date().toISOString() : null;
  db.prepare(`UPDATE activity_registrations SET checked_in=?, date_checkin=? WHERE activity_id=? AND user_id=?`)
    .run(present ? 1 : 0, now, req.params.id, req.params.userId);
  logAdmin(req.user.id, 'checkin', `activite ${req.params.id} user ${req.params.userId} present=${present}`, Number(req.params.id), 'activity', req.ip);
  res.json({ ok: true });
});

app.post('/api/activities/:id/presences/bulk-checkin', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { user_ids } = req.body; // array
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids array requis' });
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE activity_registrations SET checked_in=1, date_checkin=? WHERE activity_id=? AND user_id=?`);
  user_ids.forEach(uid => stmt.run(now, req.params.id, uid));
  res.json({ ok: true, updated: user_ids.length });
});

// ── Feature 7 : Historique complet par membre ─────────────────────────────
app.get('/api/members/:id/history', authMiddleware, (req, res) => {
  const uid = parseInt(req.params.id);
  if (req.user.id !== uid && !['admin','secretaire','tresoriere'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const user = db.prepare('SELECT id,prenom,nom,email,role,plan,date_inscription,actif FROM users WHERE id=?').get(uid);
  if (!user) return res.status(404).json({ error: 'Membre introuvable' });

  const paiements = db.prepare(`SELECT id,montant,type,mois,methode,statut,date_soumission FROM payments WHERE user_id=? ORDER BY date_soumission DESC LIMIT 50`).all(uid);
  const activites = db.prepare(`SELECT a.titre,a.date_debut,a.lieu,ar.statut,ar.checked_in,ar.date_inscription
    FROM activity_registrations ar JOIN activities a ON a.id=ar.activity_id
    WHERE ar.user_id=? ORDER BY a.date_debut DESC LIMIT 30`).all(uid);
  const benevole = db.prepare(`SELECT vh.heures,vh.description,vh.date_service,vh.statut,a.titre AS activite
    FROM volunteer_hours vh LEFT JOIN activities a ON a.id=vh.activity_id
    WHERE vh.user_id=? ORDER BY vh.date_service DESC LIMIT 30`).all(uid);
  const badges = db.prepare(`SELECT b.nom,b.icon,b.description,ub.date_attribution
    FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=?`).all(uid);
  const totalHeures = db.prepare(`SELECT COALESCE(SUM(heures),0) AS total FROM volunteer_hours WHERE user_id=? AND statut='approuve'`).get(uid)?.total || 0;
  const totalPaye = db.prepare(`SELECT COALESCE(SUM(montant),0) AS total FROM payments WHERE user_id=? AND statut='approuve'`).get(uid)?.total || 0;

  res.json({ user, paiements, activites, benevole, badges, totalHeures, totalPaye });
});

// ── Feature 8 : Badges ────────────────────────────────────────────────────
app.get('/api/badges', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM badges ORDER BY id').all());
});

app.get('/api/users/:id/badges', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT b.*, ub.date_attribution FROM user_badges ub
    JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=? ORDER BY ub.date_attribution DESC`).all(req.params.id);
  res.json(rows);
});

app.post('/api/badges/auto-assign', authMiddleware, requireRole('admin'), (req, res) => {
  const users = db.prepare(`SELECT u.*,
    COALESCE((SELECT SUM(heures) FROM volunteer_hours WHERE user_id=u.id AND statut='approuve'),0) AS total_heures,
    (SELECT COUNT(*) FROM user_badges WHERE user_id=u.id) AS nb_badges,
    (SELECT COUNT(*) FROM users WHERE referred_by=u.id) AS nb_parrainages,
    (SELECT COUNT(*) FROM talents WHERE user_id=u.id AND statut='approuve') AS nb_talents
    FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0)`).all();

  const adminId = req.user.id;
  const now = new Date().toISOString().substring(0,10);
  let total = 0;

  const assign = (userId, code) => {
    try {
      const badge = db.prepare('SELECT id FROM badges WHERE code=?').get(code);
      if (!badge) return;
      const exists = db.prepare('SELECT id FROM user_badges WHERE user_id=? AND badge_id=?').get(userId, badge.id);
      if (exists) return;
      db.prepare('INSERT INTO user_badges (user_id, badge_id, attribue_par) VALUES (?,?,?)').run(userId, badge.id, adminId);
      total++;
    } catch {}
  };

  users.forEach(u => {
    const inscrit = new Date(u.date_inscription || '2025-01-01');
    const anneesService = (new Date() - inscrit) / (1000*60*60*24*365);
    if (anneesService >= 5) assign(u.id, 'membre_5ans');
    else if (anneesService >= 3) assign(u.id, 'membre_3ans');
    else if (anneesService >= 1) assign(u.id, 'membre_1an');
    if (u.total_heures >= 100) assign(u.id, 'benevole_100h');
    else if (u.total_heures >= 25) assign(u.id, 'benevole_25h');
    if (u.plan === 'bienfaiteur') assign(u.id, 'bienfaiteur');
    if (u.plan === 'partenaire') assign(u.id, 'partenaire');
    if (u.nb_parrainages > 0) assign(u.id, 'parrain');
    if (u.nb_talents > 0) assign(u.id, 'talent');
    if (inscrit.getFullYear() < 2022) assign(u.id, 'fondateur');
  });

  logAdmin(adminId, 'badges_auto_assign', `${total} badges attribués`, null, 'badge', req.ip);
  res.json({ ok: true, assigned: total });
});

app.post('/api/users/:id/badges', authMiddleware, requireRole('admin'), (req, res) => {
  const { badge_code } = req.body;
  const badge = db.prepare('SELECT id FROM badges WHERE code=?').get(badge_code);
  if (!badge) return res.status(404).json({ error: 'Badge introuvable' });
  try {
    db.prepare('INSERT INTO user_badges (user_id, badge_id, attribue_par) VALUES (?,?,?)').run(req.params.id, badge.id, req.user.id);
    logAdmin(req.user.id, 'badge_manuel', `${badge_code} → user ${req.params.id}`, badge.id, 'badge', req.ip);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Badge déjà attribué' }); }
});

app.delete('/api/users/:id/badges/:badgeId', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM user_badges WHERE user_id=? AND badge_id=?').run(req.params.id, req.params.badgeId);
  res.json({ ok: true });
});

// ── Feature 11 : Logs d'activité admin ───────────────────────────────────
app.get('/api/activity-logs', authMiddleware, requireRole('admin'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const action = req.query.action ? `AND action LIKE ?` : '';
  const rows = db.prepare(`SELECT al.*, u.prenom||' '||u.nom AS nom_acteur
    FROM activity_logs al LEFT JOIN users u ON u.id=al.user_id
    ${action ? 'WHERE al.action LIKE ?' : ''}
    ORDER BY al.date_action DESC LIMIT ?`).all(
    ...(req.query.action ? [`%${req.query.action}%`, limit] : [limit])
  );
  res.json(rows);
});

// ── Feature 12 : Signatures électroniques ────────────────────────────────
app.post('/api/documents/:id/sign', authMiddleware, (req, res) => {
  const { signature_data } = req.body;
  if (!signature_data) return res.status(400).json({ error: 'Signature requise' });
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document introuvable' });
  try {
    db.prepare(`INSERT OR REPLACE INTO document_signatures (document_id,user_id,signature_data,ip)
      VALUES (?,?,?,?)`).run(doc.id, req.user.id, signature_data, req.ip);
    logAdmin(req.user.id, 'signature_document', `doc ${doc.id} — ${doc.nom}`, doc.id, 'document', req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/documents/:id/signatures', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT ds.*, u.prenom||' '||u.nom AS nom_signataire, u.role
    FROM document_signatures ds JOIN users u ON u.id=ds.user_id
    WHERE ds.document_id=? ORDER BY ds.date_signature`).all(req.params.id);
  res.json(rows);
});

// ── Feature 15 : Liste de billets pour cache hors-ligne ──────────────────
app.get('/api/activities/:id/tickets-list', authMiddleware, requireRole('admin','secretaire','delegue','tresoriere'), (req, res) => {
  const tickets = db.prepare(`SELECT qr_data, barcode_data, acheteur_nom, acheteur_email, statut, checked_in, date_checkin, quantite
    FROM tickets WHERE activity_id=? AND statut='actif' ORDER BY id`).all(req.params.id);
  logAdmin(req.user.id, 'tickets_cache_offline', `activite ${req.params.id} — ${tickets.length} billets`, Number(req.params.id), 'activity', req.ip);
  res.json(tickets);
});

// ── Feature 13 : Calendrier iCal ─────────────────────────────────────────
const { randomUUID } = require('crypto');

app.get('/api/calendar/token', authMiddleware, (req, res) => {
  let user = db.prepare('SELECT ical_token FROM users WHERE id=?').get(req.user.id);
  if (!user.ical_token) {
    const token = randomUUID();
    db.prepare('UPDATE users SET ical_token=? WHERE id=?').run(token, req.user.id);
    user = { ical_token: token };
  }
  const base = process.env.SITE_URL || `http://localhost:${PORT}`;
  res.json({ url: `${base}/api/calendar/${user.ical_token}.ics` });
});

app.get('/api/calendar/:token.ics', (req, res) => {
  const user = db.prepare('SELECT id,prenom,nom FROM users WHERE ical_token=?').get(req.params.token);
  if (!user) return res.status(404).send('Token invalide');
  const activities = db.prepare(`SELECT * FROM activities WHERE statut != 'annulee' AND date_debut IS NOT NULL ORDER BY date_debut DESC LIMIT 100`).all();
  const regs = db.prepare('SELECT activity_id FROM activity_registrations WHERE user_id=?').all(user.id).map(r => r.activity_id);

  function icalDate(d) {
    return new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  }

  const events = activities.map(a => {
    const start = icalDate(a.date_debut);
    const end = a.date_fin ? icalDate(a.date_fin) : start;
    const registered = regs.includes(a.id) ? '\nCATEGORIES:Inscrit' : '';
    return [
      'BEGIN:VEVENT',
      `UID:ahh-act-${a.id}@ahhamilton.ca`,
      `DTSTAMP:${icalDate(new Date().toISOString())}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${(a.titre||'').replace(/,/g,'\\,')}`,
      `DESCRIPTION:${(a.description||'').replace(/\n/g,'\\n').replace(/,/g,'\\,')}`,
      `LOCATION:${(a.lieu||'').replace(/,/g,'\\,')}`,
      registered,
      'END:VEVENT'
    ].filter(Boolean).join('\r\n');
  }).join('\r\n');

  const cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AHH Hamilton//Dashboard//FR',
    `X-WR-CALNAME:AHH Hamilton — ${user.prenom}`,
    'X-WR-TIMEZONE:America/Toronto',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    events,
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type','text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="ahh-calendar.ics"');
  res.send(cal);
});

// ── Ambassadeur du mois ─────────────────────────────────────────────────────
app.get('/api/ambassador', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM ambassador WHERE id=1').get();
    if (!row || !row.nom) return res.json(null);
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ambassador/photo', authMiddleware, requireRole('admin'), uploadAmbassador.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Photo requise' });
  await compressImage(req.file.path, 1200);
  const photo_url = `/uploads/ambassador/${req.file.filename}`;
  res.json({ photo_url });
});
app.use('/uploads/ambassador', express.static(path.join(__dirname, 'uploads', 'ambassador')));

app.put('/api/ambassador', authMiddleware, requireRole('admin'), (req, res) => {
  const { nom, prenom, role_description, citation, photo_url, user_id } = req.body;
  try {
    db.prepare(`UPDATE ambassador SET nom=?, prenom=?, role_description=?, citation=?,
      photo_url=?, user_id=?, mois=strftime('%Y-%m','now'), updated_at=datetime('now')
      WHERE id=1`).run(nom||null, prenom||null, role_description||'', citation||'', photo_url||null, user_id||null);
    logAdmin(req.user.userId, 'ambassador_update', `${prenom} ${nom}`, null, null, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Guide d'accueil PDF ──────────────────────────────────────────────────────
app.get('/api/guide.pdf', (req, res) => {
  const pdfPath = require('path').join(__dirname, 'Public', 'guide-accueil.pdf');
  const fs = require('fs');
  if (fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Guide-Accueil-AHH.pdf"');
    return res.sendFile(pdfPath);
  }
  // Générer un PDF minimal si le fichier n'existe pas encore
  const content = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 200>>stream\nBT /F1 18 Tf 72 700 Td (Guide d\'accueil AHH) Tj 0 -40 Td /F1 12 Tf (Association Haitienne de Hamilton) Tj 0 -25 Td (ahhamilton.ca | contact@ahhamilton.ca) Tj 0 -25 Td (905-818-8269 / 905-519-7967) Tj 0 -40 Td (Bienvenue dans la communaute AHH !) Tj ET\nendstream\nendobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'xref\n0 6\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000274 00000 n\n0000000527 00000 n',
    'trailer<</Size 6/Root 1 0 R>>',
    'startxref\n600',
    '%%EOF'
  ].join('\n');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Guide-Accueil-AHH.pdf"');
  res.send(Buffer.from(content, 'latin1'));
});

// ══════════════════════════════════════════════════════════════════════════════
// DÉLÉGATION DE SCAN
// ══════════════════════════════════════════════════════════════════════════════

const SCAN_EXEC_ROLES = ['admin','tresoriere','secretaire','delegue'];

// Créer une délégation de scan
app.post('/api/scan-delegations', authMiddleware, requireRole(...SCAN_EXEC_ROLES), (req, res) => {
  const { activity_id, user_id, type, date_expiration } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id requis' });
  const user = db.prepare('SELECT id, prenom, nom FROM users WHERE id = ? AND actif = 1').get(user_id);
  if (!user) return res.status(404).json({ error: 'Membre introuvable' });
  // Vérifier doublon actif
  const existing = db.prepare('SELECT id FROM scan_delegations WHERE user_id = ? AND actif = 1 AND (activity_id = ? OR (activity_id IS NULL AND ? IS NULL))').get(user_id, activity_id || null, activity_id || null);
  if (existing) return res.status(409).json({ error: 'Ce membre a déjà une délégation active pour cette activité' });
  const result = db.prepare('INSERT INTO scan_delegations (activity_id, user_id, delegue_par, type, date_expiration) VALUES (?,?,?,?,?)')
    .run(activity_id || null, user_id, req.user.id, type || 'billets', date_expiration || null);
  const delegUser = db.prepare('SELECT telephone FROM users WHERE id=?').get(user_id);
  if (delegUser && delegUser.telephone) sendSMS(delegUser.telephone, `AHH: Vous avez reçu une délégation de scan (${type || 'billets'}).`).catch(()=>{});
  res.json({ ok: true, id: result.lastInsertRowid });
});

// Lister les délégations actives (pour EXEC)
app.get('/api/scan-delegations', authMiddleware, requireRole(...SCAN_EXEC_ROLES), (req, res) => {
  const actId = req.query.activity_id;
  let rows;
  if (actId) {
    rows = db.prepare(`SELECT sd.*, u.prenom, u.nom, u.email,
      dp.prenom AS delegue_par_prenom, dp.nom AS delegue_par_nom,
      a.titre AS activite_titre
      FROM scan_delegations sd
      JOIN users u ON u.id = sd.user_id
      JOIN users dp ON dp.id = sd.delegue_par
      LEFT JOIN activities a ON a.id = sd.activity_id
      WHERE sd.actif = 1 AND sd.activity_id = ?
      ORDER BY sd.date_creation DESC`).all(actId);
  } else {
    rows = db.prepare(`SELECT sd.*, u.prenom, u.nom, u.email,
      dp.prenom AS delegue_par_prenom, dp.nom AS delegue_par_nom,
      a.titre AS activite_titre
      FROM scan_delegations sd
      JOIN users u ON u.id = sd.user_id
      JOIN users dp ON dp.id = sd.delegue_par
      LEFT JOIN activities a ON a.id = sd.activity_id
      WHERE sd.actif = 1
      ORDER BY sd.date_creation DESC`).all();
  }
  res.json(rows);
});

// Mes délégations (pour tout utilisateur authentifié)
app.get('/api/scan-delegations/my', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT sd.*, a.titre AS activite_titre, a.date_debut, a.statut AS activite_statut,
    dp.prenom AS delegue_par_prenom, dp.nom AS delegue_par_nom
    FROM scan_delegations sd
    LEFT JOIN activities a ON a.id = sd.activity_id
    JOIN users dp ON dp.id = sd.delegue_par
    WHERE sd.user_id = ? AND sd.actif = 1
      AND (sd.date_expiration IS NULL OR sd.date_expiration > datetime('now'))
    ORDER BY sd.date_creation DESC`).all(req.user.id);
  res.json(rows);
});

// Révoquer une délégation
app.delete('/api/scan-delegations/:id', authMiddleware, requireRole(...SCAN_EXEC_ROLES), (req, res) => {
  const d = db.prepare('SELECT id FROM scan_delegations WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Délégation introuvable' });
  db.prepare('UPDATE scan_delegations SET actif = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Journal des scans
app.get('/api/scan-logs', authMiddleware, (req, res) => {
  const actId = req.query.activity_id;
  const isExec = SCAN_EXEC_ROLES.includes(req.user.role);
  if (!isExec) {
    // Vérifier que l'utilisateur a une délégation active pour cette activité
    const hasDel = db.prepare("SELECT id FROM scan_delegations WHERE user_id = ? AND actif = 1 AND (activity_id IS NULL OR activity_id = ?) AND (date_expiration IS NULL OR date_expiration > datetime('now'))").get(req.user.id, actId || 0);
    if (!hasDel) return res.status(403).json({ error: 'Accès refusé' });
  }
  const rows = db.prepare(`SELECT sl.*, u.prenom AS scanner_prenom, u.nom AS scanner_nom,
    t.acheteur_nom, t.acheteur_email, t.barcode_data,
    COALESCE(v.prenom || ' ' || v.nom, '') AS vendu_par_nom
    FROM scan_logs sl
    JOIN users u ON u.id = sl.scanner_id
    LEFT JOIN tickets t ON t.id = sl.ticket_id
    LEFT JOIN users v ON v.id = t.vendu_par
    WHERE (? IS NULL OR sl.activity_id = ?)
    ORDER BY sl.date_scan DESC
    LIMIT 500`).all(actId || null, actId || null);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// FORMULAIRES (Google Forms-like)
// ══════════════════════════════════════════════════════════════════════════════

const FORM_EXEC = ['admin','tresoriere','secretaire','delegue'];

// Multer pour images de formulaires
const formImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'forms', String(req.params.id || 'tmp'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadFormImage = multer({ storage: formImageStorage, limits: { fileSize: 15 * 1024 * 1024 } });

// ── Liste tous les formulaires ──────────────────────────────────────────────
app.get('/api/forms', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const rows = db.prepare(`SELECT f.*,
    (SELECT COUNT(*) FROM form_responses fr WHERE fr.form_id = f.id) AS nb_reponses,
    u.prenom AS createur_prenom, u.nom AS createur_nom
    FROM forms f LEFT JOIN users u ON u.id = f.cree_par
    ORDER BY f.date_creation DESC`).all();
  res.json(rows);
});

// ── Détail d'un formulaire avec champs et réponses ──────────────────────────
app.get('/api/forms/:id', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable' });
  form.fields = db.prepare('SELECT * FROM form_fields WHERE form_id = ? ORDER BY ordre, id').all(form.id);
  form.responses = db.prepare(`SELECT fr.*,
    (SELECT json_group_array(json_object('field_id', fa.field_id, 'valeur', fa.valeur))
     FROM form_answers fa WHERE fa.response_id = fr.id) AS answers_json
    FROM form_responses fr WHERE fr.form_id = ? ORDER BY fr.date_reponse DESC`).all(form.id);
  // Parse answers_json
  form.responses.forEach(r => {
    try { r.answers = JSON.parse(r.answers_json || '[]'); } catch { r.answers = []; }
    delete r.answers_json;
  });
  res.json(form);
});

// ── Créer un formulaire ─────────────────────────────────────────────────────
app.post('/api/forms', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const { titre, description, activity_id, allow_anonymous, message_fin, redirect_adhesion } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const crypto = require('crypto');
  const share_token = crypto.randomBytes(12).toString('hex');
  const r = db.prepare(`INSERT INTO forms (titre, description, share_token, activity_id, allow_anonymous, message_fin, redirect_adhesion, cree_par)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    titre, description || null, share_token, activity_id || null,
    allow_anonymous === undefined ? 1 : (allow_anonymous ? 1 : 0),
    message_fin || 'Merci pour votre réponse !',
    redirect_adhesion === undefined ? 1 : (redirect_adhesion ? 1 : 0),
    req.user.id
  );
  res.status(201).json({ id: r.lastInsertRowid, share_token });
});

// ── Modifier un formulaire ──────────────────────────────────────────────────
app.put('/api/forms/:id', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const form = db.prepare('SELECT id FROM forms WHERE id = ?').get(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable' });
  const { titre, description, activity_id, statut, allow_anonymous, message_fin, redirect_adhesion, date_fermeture } = req.body;
  db.prepare(`UPDATE forms SET titre=?, description=?, activity_id=?, statut=?, allow_anonymous=?, message_fin=?, redirect_adhesion=?, date_fermeture=? WHERE id=?`).run(
    titre, description || null, activity_id || null, statut || 'actif',
    allow_anonymous ? 1 : 0, message_fin || 'Merci pour votre réponse !',
    redirect_adhesion ? 1 : 0, date_fermeture || null, req.params.id
  );
  res.json({ message: 'Formulaire mis à jour' });
});

// ── Supprimer un formulaire ─────────────────────────────────────────────────
app.delete('/api/forms/:id', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const form = db.prepare('SELECT id FROM forms WHERE id = ?').get(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable' });
  db.prepare('DELETE FROM forms WHERE id = ?').run(req.params.id);
  res.json({ message: 'Formulaire supprimé' });
});

// ── Upload image pour un formulaire ─────────────────────────────────────────
app.post('/api/forms/:id/image', authMiddleware, requireRole(...FORM_EXEC), uploadFormImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image requise' });
  await compressImage(req.file.path, 1200);
  const imagePath = `/uploads/forms/${req.params.id}/${req.file.filename}`;
  db.prepare('UPDATE forms SET image_path=? WHERE id=?').run(imagePath, req.params.id);
  res.json({ image_path: imagePath });
});
app.use('/uploads/forms', express.static(path.join(__dirname, 'uploads', 'forms')));

// ── Ajouter un champ ────────────────────────────────────────────────────────
app.post('/api/forms/:id/fields', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const form = db.prepare('SELECT id FROM forms WHERE id = ?').get(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable' });
  const { type, label, description, obligatoire, options_json, ordre } = req.body;
  if (!label) return res.status(400).json({ error: 'Label requis' });
  const r = db.prepare(`INSERT INTO form_fields (form_id, type, label, description, obligatoire, options_json, ordre)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    req.params.id, type || 'text', label, description || null,
    obligatoire ? 1 : 0, options_json || null,
    ordre !== undefined ? ordre : 0
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

// ── Modifier un champ ───────────────────────────────────────────────────────
app.put('/api/forms/:formId/fields/:fieldId', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const field = db.prepare('SELECT id FROM form_fields WHERE id = ? AND form_id = ?').get(req.params.fieldId, req.params.formId);
  if (!field) return res.status(404).json({ error: 'Champ introuvable' });
  const { type, label, description, obligatoire, options_json, ordre } = req.body;
  db.prepare(`UPDATE form_fields SET type=?, label=?, description=?, obligatoire=?, options_json=?, ordre=? WHERE id=?`).run(
    type || 'text', label, description || null, obligatoire ? 1 : 0,
    options_json || null, ordre !== undefined ? ordre : 0, req.params.fieldId
  );
  res.json({ message: 'Champ mis à jour' });
});

// ── Supprimer un champ ──────────────────────────────────────────────────────
app.delete('/api/forms/:formId/fields/:fieldId', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const field = db.prepare('SELECT id FROM form_fields WHERE id = ? AND form_id = ?').get(req.params.fieldId, req.params.formId);
  if (!field) return res.status(404).json({ error: 'Champ introuvable' });
  db.prepare('DELETE FROM form_fields WHERE id = ?').run(req.params.fieldId);
  res.json({ message: 'Champ supprimé' });
});

// ── Export CSV des réponses ─────────────────────────────────────────────────
app.get('/api/forms/:id/export', authMiddleware, requireRole(...FORM_EXEC), (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable' });
  const fields = db.prepare('SELECT * FROM form_fields WHERE form_id = ? ORDER BY ordre, id').all(form.id);
  const responses = db.prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY date_reponse DESC').all(form.id);

  // Build CSV
  const cols = ['Date', 'Nom', 'Email', 'Téléphone'];
  fields.forEach(f => cols.push(f.label));

  const escCsv = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const header = cols.map(escCsv).join(',');

  const lines = responses.map(r => {
    const answers = db.prepare('SELECT field_id, valeur FROM form_answers WHERE response_id = ?').all(r.id);
    const answerMap = {};
    answers.forEach(a => { answerMap[a.field_id] = a.valeur; });
    const row = [r.date_reponse, r.nom, r.email, r.telephone];
    fields.forEach(f => row.push(answerMap[f.id] || ''));
    return row.map(escCsv).join(',');
  });

  const csv = '﻿' + [header, ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="formulaire-${form.id}-reponses.csv"`);
  res.send(csv);
});

// ── PUBLIC : récupérer un formulaire par token ──────────────────────────────
app.get('/api/forms/public/:token', (req, res) => {
  const form = db.prepare('SELECT id, titre, description, image_path, share_token, activity_id, allow_anonymous, message_fin, redirect_adhesion FROM forms WHERE share_token = ? AND statut = ?').get(req.params.token, 'actif');
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable ou fermé' });
  form.fields = db.prepare('SELECT id, type, label, description, obligatoire, options_json, ordre FROM form_fields WHERE form_id = ? ORDER BY ordre, id').all(form.id);
  res.json(form);
});

// ── PUBLIC : soumettre une réponse ──────────────────────────────────────────
app.post('/api/forms/public/:token/respond', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE share_token = ? AND statut = ?').get(req.params.token, 'actif');
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable ou fermé' });
  const { nom, email, telephone, answers } = req.body;
  const r = db.prepare('INSERT INTO form_responses (form_id, nom, email, telephone) VALUES (?, ?, ?, ?)').run(
    form.id, nom || null, email || null, telephone || null
  );
  const responseId = r.lastInsertRowid;
  if (answers && Array.isArray(answers)) {
    const insertAnswer = db.prepare('INSERT INTO form_answers (response_id, field_id, valeur) VALUES (?, ?, ?)');
    answers.forEach(a => {
      if (a.field_id && a.valeur !== undefined) {
        insertAnswer.run(responseId, a.field_id, String(a.valeur));
      }
    });
  }
  res.json({ ok: true, message: form.message_fin, redirect_adhesion: form.redirect_adhesion ? true : false });
});

// ══════════════════════════════════════════════════════════════════════════════
// TÂCHES ASSIGNÉES
// ══════════════════════════════════════════════════════════════════════════════

const EXEC_ROLES = ['admin','tresoriere','secretaire','delegue'];

// Recherche de membres par nom (autocomplétion)
app.get('/api/members/search', authMiddleware, (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`SELECT id, prenom, nom, email, role FROM users
    WHERE actif=1 AND (phantom IS NULL OR phantom=0)
    AND (prenom || ' ' || nom LIKE ? OR email LIKE ?)
    ORDER BY nom LIMIT 10`).all(`%${q}%`, `%${q}%`);
  res.json(rows);
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT t.*, u.prenom || ' ' || u.nom AS assigne_nom,
    c.prenom || ' ' || c.nom AS createur_nom
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigne_a
    LEFT JOIN users c ON c.id = t.cree_par
    ORDER BY CASE t.priorite WHEN 'haute' THEN 1 WHEN 'moyenne' THEN 2 ELSE 3 END, t.date_creation DESC`).all();
  res.json(rows);
});

app.get('/api/tasks/my', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT t.*, u.prenom || ' ' || u.nom AS assigne_nom,
    c.prenom || ' ' || c.nom AS createur_nom
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigne_a
    LEFT JOIN users c ON c.id = t.cree_par
    WHERE t.assigne_a = ?
    ORDER BY CASE t.priorite WHEN 'haute' THEN 1 WHEN 'moyenne' THEN 2 ELSE 3 END, t.date_creation DESC`).all(req.user.id);
  res.json(rows);
});

app.post('/api/tasks', authMiddleware, requireRole(...EXEC_ROLES), async (req, res) => {
  const { titre, description, statut, priorite, assigne_a, echeance, categorie } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const r = db.prepare(`INSERT INTO tasks (titre, description, statut, priorite, assigne_a, cree_par, echeance, categorie)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(titre, description||'', statut||'a_faire', priorite||'moyenne', assigne_a||null, req.user.id, echeance||null, categorie||'autre');
  if (assigne_a) {
    const assignee = db.prepare('SELECT prenom, nom, email FROM users WHERE id=?').get(assigne_a);
    if (assignee?.email) {
      const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
      const prioriteLabel = {haute:'Haute',moyenne:'Moyenne',basse:'Basse'}[priorite] || priorite || 'Moyenne';
      mailer.sendMail({
        to: assignee.email,
        subject: `📋 Nouvelle tâche assignée — ${titre}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden">
          <div style="background:#1a237e;color:#fff;padding:20px 24px"><h2 style="margin:0;font-size:1.1rem">📋 Nouvelle tâche assignée</h2></div>
          <div style="padding:24px">
            <p>Bonjour <strong>${assignee.prenom}</strong>,</p>
            <p>Une nouvelle tâche vous a été assignée par <strong>${req.user.prenom} ${req.user.nom}</strong> :</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:8px;color:#888;width:120px">Titre</td><td style="padding:8px;font-weight:700">${titre}</td></tr>
              ${description ? `<tr><td style="padding:8px;color:#888">Description</td><td style="padding:8px">${description}</td></tr>` : ''}
              <tr><td style="padding:8px;color:#888">Priorité</td><td style="padding:8px">${prioriteLabel}</td></tr>
              ${echeance ? `<tr><td style="padding:8px;color:#888">Échéance</td><td style="padding:8px">${echeance}</td></tr>` : ''}
              ${categorie ? `<tr><td style="padding:8px;color:#888">Catégorie</td><td style="padding:8px">${categorie}</td></tr>` : ''}
            </table>
            <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">Voir mes tâches</a>
          </div>
        </div>`
      }).catch(e => console.error('[TASK EMAIL]', e.message));
      createAlert(parseInt(assigne_a), 'tache', `📋 Tâche assignée : ${titre}`, description || '');
      const assigneeFull = db.prepare('SELECT telephone FROM users WHERE id=?').get(assigne_a);
      if (assigneeFull && assigneeFull.telephone) sendSMS(assigneeFull.telephone, `AHH: Nouvelle tâche assignée — ${titre}`).catch(()=>{});
    }
  }
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/tasks/:id', authMiddleware, requireRole(...EXEC_ROLES), async (req, res) => {
  const { titre, description, statut, priorite, assigne_a, echeance, categorie } = req.body;
  const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tâche introuvable' });
  const dateCompletion = statut === 'terminee' ? new Date().toISOString() : null;
  db.prepare(`UPDATE tasks SET titre=?, description=?, statut=?, priorite=?, assigne_a=?, echeance=?, categorie=?, date_completion=COALESCE(?,date_completion) WHERE id=?`)
    .run(titre, description||'', statut||'a_faire', priorite||'moyenne', assigne_a||null, echeance||null, categorie||'autre', dateCompletion, req.params.id);
  if (assigne_a && String(assigne_a) !== String(existing.assigne_a)) {
    const assignee = db.prepare('SELECT prenom, nom, email FROM users WHERE id=?').get(assigne_a);
    if (assignee?.email) {
      const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
      mailer.sendMail({
        to: assignee.email,
        subject: `📋 Tâche assignée — ${titre}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden">
          <div style="background:#1a237e;color:#fff;padding:20px 24px"><h2 style="margin:0;font-size:1.1rem">📋 Tâche assignée</h2></div>
          <div style="padding:24px">
            <p>Bonjour <strong>${assignee.prenom}</strong>,</p>
            <p><strong>${req.user.prenom} ${req.user.nom}</strong> vous a assigné une tâche :</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:8px;color:#888;width:120px">Titre</td><td style="padding:8px;font-weight:700">${titre}</td></tr>
              ${description ? `<tr><td style="padding:8px;color:#888">Description</td><td style="padding:8px">${description}</td></tr>` : ''}
              ${echeance ? `<tr><td style="padding:8px;color:#888">Échéance</td><td style="padding:8px">${echeance}</td></tr>` : ''}
            </table>
            <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Voir mes tâches</a>
          </div>
        </div>`
      }).catch(e => console.error('[TASK EMAIL]', e.message));
      createAlert(parseInt(assigne_a), 'tache', `📋 Tâche assignée : ${titre}`, description || '');
      const assigneeFull2 = db.prepare('SELECT telephone FROM users WHERE id=?').get(assigne_a);
      if (assigneeFull2 && assigneeFull2.telephone) sendSMS(assigneeFull2.telephone, `AHH: Tâche assignée — ${titre}`).catch(()=>{});
    }
  }
  res.json({ message: 'Tâche mise à jour' });
});

app.delete('/api/tasks/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id FROM tasks WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tâche introuvable' });
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  res.json({ message: 'Tâche supprimée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// ORDRE DU JOUR (AGENDAS)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/agendas', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.prenom || ' ' || u.nom AS createur_nom,
    (SELECT COUNT(*) FROM agenda_items WHERE agenda_id = a.id) AS nb_items
    FROM agendas a LEFT JOIN users u ON u.id = a.cree_par
    ORDER BY a.date_reunion DESC`).all();
  res.json(rows);
});

app.get('/api/agendas/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const agenda = db.prepare(`SELECT a.*, u.prenom || ' ' || u.nom AS createur_nom
    FROM agendas a LEFT JOIN users u ON u.id = a.cree_par WHERE a.id=?`).get(req.params.id);
  if (!agenda) return res.status(404).json({ error: 'Agenda introuvable' });
  const items = db.prepare(`SELECT ai.*, u.prenom || ' ' || u.nom AS responsable_nom
    FROM agenda_items ai LEFT JOIN users u ON u.id = ai.responsable_id
    WHERE ai.agenda_id=? ORDER BY ai.ordre`).all(req.params.id);
  res.json({ ...agenda, items });
});

app.post('/api/agendas', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { titre, date_reunion, statut } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const r = db.prepare('INSERT INTO agendas (titre, date_reunion, statut, cree_par) VALUES (?,?,?,?)')
    .run(titre, date_reunion||null, statut||'brouillon', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/agendas/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { titre, date_reunion, statut } = req.body;
  const existing = db.prepare('SELECT id FROM agendas WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agenda introuvable' });
  db.prepare('UPDATE agendas SET titre=?, date_reunion=?, statut=? WHERE id=?')
    .run(titre, date_reunion||null, statut||'brouillon', req.params.id);
  res.json({ message: 'Agenda mis à jour' });
});

app.delete('/api/agendas/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id FROM agendas WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agenda introuvable' });
  db.prepare('DELETE FROM agendas WHERE id=?').run(req.params.id);
  res.json({ message: 'Agenda supprimé' });
});

// Agenda items
app.post('/api/agendas/:id/items', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { texte, ordre, duree_minutes, responsable_id, note } = req.body;
  if (!texte) return res.status(400).json({ error: 'Texte requis' });
  const existing = db.prepare('SELECT id FROM agendas WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agenda introuvable' });
  const r = db.prepare('INSERT INTO agenda_items (agenda_id, texte, ordre, duree_minutes, responsable_id, note) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, texte, ordre||0, duree_minutes||5, responsable_id||null, note||null);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/agendas/:agendaId/items/:itemId', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { texte, ordre, duree_minutes, responsable_id, note } = req.body;
  const existing = db.prepare('SELECT id FROM agenda_items WHERE id=? AND agenda_id=?').get(req.params.itemId, req.params.agendaId);
  if (!existing) return res.status(404).json({ error: 'Item introuvable' });
  db.prepare('UPDATE agenda_items SET texte=?, ordre=?, duree_minutes=?, responsable_id=?, note=? WHERE id=?')
    .run(texte, ordre||0, duree_minutes||5, responsable_id||null, note||null, req.params.itemId);
  res.json({ message: 'Item mis à jour' });
});

app.delete('/api/agendas/:agendaId/items/:itemId', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id FROM agenda_items WHERE id=? AND agenda_id=?').get(req.params.itemId, req.params.agendaId);
  if (!existing) return res.status(404).json({ error: 'Item introuvable' });
  db.prepare('DELETE FROM agenda_items WHERE id=?').run(req.params.itemId);
  res.json({ message: 'Item supprimé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRE DES DÉCISIONS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/decisions', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT d.*, u.prenom || ' ' || u.nom AS responsable_nom,
    c.prenom || ' ' || c.nom AS createur_nom
    FROM decisions d
    LEFT JOIN users u ON u.id = d.responsable_id
    LEFT JOIN users c ON c.id = d.cree_par
    ORDER BY d.date_creation DESC`).all();
  res.json(rows);
});

app.get('/api/decisions/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const row = db.prepare(`SELECT d.*, u.prenom || ' ' || u.nom AS responsable_nom,
    c.prenom || ' ' || c.nom AS createur_nom
    FROM decisions d
    LEFT JOIN users u ON u.id = d.responsable_id
    LEFT JOIN users c ON c.id = d.cree_par
    WHERE d.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Décision introuvable' });
  res.json(row);
});

app.post('/api/decisions', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { titre, description, date_decision, decidee_par, responsable_id, echeance, statut, agenda_id } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const r = db.prepare(`INSERT INTO decisions (titre, description, date_decision, decidee_par, responsable_id, echeance, statut, agenda_id, cree_par)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(titre, description||'', date_decision||null, decidee_par||null, responsable_id||null, echeance||null, statut||'en_cours', agenda_id||null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/decisions/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { titre, description, date_decision, decidee_par, responsable_id, echeance, statut, agenda_id } = req.body;
  const existing = db.prepare('SELECT id FROM decisions WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Décision introuvable' });
  db.prepare(`UPDATE decisions SET titre=?, description=?, date_decision=?, decidee_par=?, responsable_id=?, echeance=?, statut=?, agenda_id=? WHERE id=?`)
    .run(titre, description||'', date_decision||null, decidee_par||null, responsable_id||null, echeance||null, statut||'en_cours', agenda_id||null, req.params.id);
  res.json({ message: 'Décision mise à jour' });
});

app.delete('/api/decisions/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id FROM decisions WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Décision introuvable' });
  db.prepare('DELETE FROM decisions WHERE id=?').run(req.params.id);
  res.json({ message: 'Décision supprimée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// POLITIQUES ET RÈGLEMENTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/policies', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT p.*, u.prenom || ' ' || u.nom AS createur_nom,
    a.prenom || ' ' || a.nom AS approuveur_nom
    FROM policies p
    LEFT JOIN users u ON u.id = p.cree_par
    LEFT JOIN users a ON a.id = p.approuve_par
    ORDER BY p.date_creation DESC`).all();
  res.json(rows);
});

app.get('/api/policies/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const row = db.prepare(`SELECT p.*, u.prenom || ' ' || u.nom AS createur_nom,
    a.prenom || ' ' || a.nom AS approuveur_nom
    FROM policies p
    LEFT JOIN users u ON u.id = p.cree_par
    LEFT JOIN users a ON a.id = p.approuve_par
    WHERE p.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Politique introuvable' });
  res.json(row);
});

app.post('/api/policies', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { titre, categorie, contenu, version, statut, approuve_par, date_approbation } = req.body;
  if (!titre) return res.status(400).json({ error: 'Titre requis' });
  const r = db.prepare(`INSERT INTO policies (titre, categorie, contenu, version, statut, approuve_par, date_approbation, cree_par)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(titre, categorie||'reglement', contenu||'', version||'1.0', statut||'brouillon', approuve_par||null, date_approbation||null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/policies/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const { titre, categorie, contenu, version, statut, approuve_par, date_approbation } = req.body;
  const existing = db.prepare('SELECT id FROM policies WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Politique introuvable' });
  db.prepare(`UPDATE policies SET titre=?, categorie=?, contenu=?, version=?, statut=?, approuve_par=?, date_approbation=?, date_modification=CURRENT_TIMESTAMP WHERE id=?`)
    .run(titre, categorie||'reglement', contenu||'', version||'1.0', statut||'brouillon', approuve_par||null, date_approbation||null, req.params.id);
  res.json({ message: 'Politique mise à jour' });
});

app.delete('/api/policies/:id', authMiddleware, requireRole('admin','secretaire'), (req, res) => {
  const existing = db.prepare('SELECT id FROM policies WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Politique introuvable' });
  db.prepare('DELETE FROM policies WHERE id=?').run(req.params.id);
  res.json({ message: 'Politique supprimée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// JOURNAL D'AUDIT
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/audit', authMiddleware, requireRole('admin'), (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  const rows = db.prepare(`SELECT al.*, u.prenom || ' ' || u.nom AS user_nom, u.email AS user_email
    FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    ORDER BY al.date_action DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json({ rows, total, page, limit, pages: Math.ceil(total / limit) });
});

// ══════════════════════════════════════════════════════════════════════════════
// MODÈLES DE COURRIELS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/email-templates', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT et.*, u.prenom || ' ' || u.nom AS createur_nom
    FROM email_templates et LEFT JOIN users u ON u.id = et.cree_par
    ORDER BY et.categorie, et.nom`).all();
  res.json(rows);
});

app.get('/api/email-templates/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const row = db.prepare(`SELECT et.*, u.prenom || ' ' || u.nom AS createur_nom
    FROM email_templates et LEFT JOIN users u ON u.id = et.cree_par WHERE et.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Modèle introuvable' });
  res.json(row);
});

app.post('/api/email-templates', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { nom, sujet, corps, categorie } = req.body;
  if (!nom || !sujet || !corps) return res.status(400).json({ error: 'Nom, sujet et corps requis' });
  try {
    const r = db.prepare('INSERT INTO email_templates (nom, sujet, corps, categorie, cree_par) VALUES (?,?,?,?,?)')
      .run(nom, sujet, corps, categorie||'general', req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Un modèle avec ce nom existe déjà' });
    throw e;
  }
});

app.put('/api/email-templates/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { nom, sujet, corps, categorie } = req.body;
  const existing = db.prepare('SELECT id FROM email_templates WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Modèle introuvable' });
  try {
    db.prepare('UPDATE email_templates SET nom=?, sujet=?, corps=?, categorie=?, date_modification=CURRENT_TIMESTAMP WHERE id=?')
      .run(nom, sujet, corps, categorie||'general', req.params.id);
    res.json({ message: 'Modèle mis à jour' });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Un modèle avec ce nom existe déjà' });
    throw e;
  }
});

app.delete('/api/email-templates/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id FROM email_templates WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Modèle introuvable' });
  db.prepare('DELETE FROM email_templates WHERE id=?').run(req.params.id);
  res.json({ message: 'Modèle supprimé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// CALENDRIER DES RÉUNIONS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/meetings', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT ms.*, u.prenom || ' ' || u.nom AS createur_nom,
    a.titre AS agenda_titre
    FROM meeting_schedule ms
    LEFT JOIN users u ON u.id = ms.cree_par
    LEFT JOIN agendas a ON a.id = ms.agenda_id
    ORDER BY ms.date_heure ASC`).all();
  res.json(rows);
});

app.get('/api/meetings/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const row = db.prepare(`SELECT ms.*, u.prenom || ' ' || u.nom AS createur_nom,
    a.titre AS agenda_titre
    FROM meeting_schedule ms
    LEFT JOIN users u ON u.id = ms.cree_par
    LEFT JOIN agendas a ON a.id = ms.agenda_id
    WHERE ms.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Réunion introuvable' });
  res.json(row);
});

app.post('/api/meetings', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { titre, description, type, date_heure, duree_minutes, lieu, lien_virtuel, agenda_id } = req.body;
  if (!titre || !date_heure) return res.status(400).json({ error: 'Titre et date/heure requis' });
  const r = db.prepare(`INSERT INTO meeting_schedule (titre, description, type, date_heure, duree_minutes, lieu, lien_virtuel, agenda_id, cree_par)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(titre, description||'', type||'ordinaire', date_heure, duree_minutes||60, lieu||'', lien_virtuel||'', agenda_id||null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/meetings/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const { titre, description, type, date_heure, duree_minutes, lieu, lien_virtuel, agenda_id, rappel_envoye } = req.body;
  const existing = db.prepare('SELECT id FROM meeting_schedule WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Réunion introuvable' });
  db.prepare(`UPDATE meeting_schedule SET titre=?, description=?, type=?, date_heure=?, duree_minutes=?, lieu=?, lien_virtuel=?, agenda_id=?, rappel_envoye=COALESCE(?,rappel_envoye) WHERE id=?`)
    .run(titre, description||'', type||'ordinaire', date_heure, duree_minutes||60, lieu||'', lien_virtuel||'', agenda_id||null, rappel_envoye!=null?rappel_envoye:null, req.params.id);
  res.json({ message: 'Réunion mise à jour' });
});

app.delete('/api/meetings/:id', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id FROM meeting_schedule WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Réunion introuvable' });
  db.prepare('DELETE FROM meeting_schedule WHERE id=?').run(req.params.id);
  res.json({ message: 'Réunion supprimée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT CSV ACTIVITÉS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/export/activities', authMiddleware, requireRole(...EXEC_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.titre, a.type, a.date_debut, a.date_fin, a.lieu,
    a.budget_prevu, a.statut, a.prix,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=a.id) AS nb_inscrits,
    u.prenom || ' ' || u.nom AS createur
    FROM activities a LEFT JOIN users u ON u.id=a.cree_par ORDER BY a.date_debut DESC`).all();
  const csv = toCSV(rows, [
    {key:'id',label:'ID'},{key:'titre',label:'Titre'},{key:'type',label:'Type'},
    {key:'date_debut',label:'Début'},{key:'date_fin',label:'Fin'},{key:'lieu',label:'Lieu'},
    {key:'budget_prevu',label:'Budget ($)'},{key:'statut',label:'Statut'},
    {key:'prix',label:'Prix ($)'},{key:'nb_inscrits',label:'Inscrits'},
    {key:'createur',label:'Créé par'}
  ]);
  logAudit(req.user.id, 'export_activities', 'export', null, 'Export CSV activités', req.ip);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="activites-ahh.csv"');
  res.send('﻿' + csv);
});

// ══════════════════════════════════════════════════════════════════════════════
// SAUVEGARDE BASE DE DONNÉES
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/backup', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const now = new Date();
    const ts = now.getFullYear() + '-' +
      String(now.getMonth()+1).padStart(2,'0') + '-' +
      String(now.getDate()).padStart(2,'0') + '-' +
      String(now.getHours()).padStart(2,'0') +
      String(now.getMinutes()).padStart(2,'0') +
      String(now.getSeconds()).padStart(2,'0');
    const filename = `ahh-${ts}.db`;
    const destPath = path.join(backupDir, filename);
    const dbPath = process.env.DB_PATH || path.join(process.env.LOCALAPPDATA || process.env.HOME || __dirname, 'ahh-hamilton', 'ahh.db');
    fs.copyFileSync(dbPath, destPath);
    logAudit(req.user.id, 'backup_created', 'backup', null, `Sauvegarde: ${filename}`, req.ip);
    res.json({ message: 'Sauvegarde créée', filename });
  } catch(e) {
    console.error('Erreur backup:', e.message);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde: ' + e.message });
  }
});

app.get('/api/backups', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) return res.json([]);
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { filename: f, size: stat.size, date: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(files);
  } catch(e) {
    res.status(500).json({ error: 'Erreur: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// RAPPORT ANNUEL
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/reports/annual', authMiddleware, requireRole('admin'), (req, res) => {
  const annee = parseInt(req.query.annee) || new Date().getFullYear();
  const anneeStr = String(annee);

  // Membres actifs
  const total_membres = db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND role='member' AND (phantom IS NULL OR phantom=0)").get().c;

  // Nouveaux membres cette année
  const nouveaux_membres = db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1 AND (phantom IS NULL OR phantom=0) AND substr(date_inscription,1,4)=?").get(anneeStr).c;

  // Revenus (paiements approuvés cette année)
  const total_revenus = db.prepare("SELECT COALESCE(SUM(montant),0) AS t FROM payments WHERE statut='approuve' AND substr(date_soumission,1,4)=?").get(anneeStr).t;

  // Dépenses (transactions de type depense cette année)
  const total_depenses = db.prepare("SELECT COALESCE(SUM(montant),0) AS t FROM transactions WHERE type='depense' AND substr(date_transaction,1,4)=?").get(anneeStr).t;

  // Activités cette année
  const total_activites = db.prepare("SELECT COUNT(*) AS c FROM activities WHERE substr(date_debut,1,4)=?").get(anneeStr).c;

  // Total participants cette année
  const total_participants = db.prepare(`SELECT COUNT(*) AS c FROM activity_registrations ar
    JOIN activities a ON a.id=ar.activity_id WHERE substr(a.date_debut,1,4)=?`).get(anneeStr).c;

  // Taux de recouvrement des cotisations
  const cotisations_attendues = db.prepare("SELECT COUNT(*) AS c FROM cotisations WHERE substr(periode,1,4)=?").get(anneeStr).c;
  const cotisations_payees = db.prepare("SELECT COUNT(*) AS c FROM cotisations WHERE substr(periode,1,4)=? AND statut='paye'").get(anneeStr).c;
  const taux_recouvrement_cotisations = cotisations_attendues > 0 ? Math.round((cotisations_payees / cotisations_attendues) * 100) : 0;

  // Top activités par participation
  const top_activities = db.prepare(`SELECT a.titre, a.date_debut,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=a.id) AS nb_participants
    FROM activities a WHERE substr(a.date_debut,1,4)=?
    ORDER BY nb_participants DESC LIMIT 5`).all(anneeStr);

  // Distribution des plans
  const plan_distribution = db.prepare("SELECT plan, COUNT(*) AS count FROM users WHERE actif=1 AND role='member' AND (phantom IS NULL OR phantom=0) GROUP BY plan").all();

  res.json({
    annee,
    total_membres,
    nouveaux_membres,
    total_revenus,
    total_depenses,
    total_activites,
    total_participants,
    taux_recouvrement_cotisations,
    top_activities,
    plan_distribution
  });
});

// ── Sitemap SEO ──────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const pages = ['', 'index.html', 'equipe.html', 'adhesion.html', 'actualites.html', 'galerie.html', 'talents.html', 'annonces.html', 'about.html', 'privacy.html'];
  const base = process.env.SITE_URL || 'https://ahhamilton.ca';
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p => `<url><loc>${base}/${p}</loc><changefreq>weekly</changefreq></url>`).join('')}</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
});

// ══════════════════════════════════════════════════════════════════════════════
// 404 HANDLER — doit être après toutes les routes
// ── Simulation test scan 50 billets (temporaire) ──────────
app.post('/api/test/create-scan-simulation', authMiddleware, requireRole('admin','secretaire'), async (req, res) => {
  try {
    function _bc() { const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s='AHH-'; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
    const siteBase = process.env.SITE_URL || 'https://ahhamilton.ca';
    const qrDir = path.join(__dirname, 'uploads', 'qr');
    if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

    const qrToken = crypto2.randomBytes(16).toString('hex');
    const actR = db.prepare(`INSERT INTO activities (titre,description,type,date_debut,date_fin,lieu,max_participants,statut,cree_par,prix,paiement_requis,qr_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'TEST SCAN V2 — 50 billets simulation', '50 billets avec toutes les situations possibles pour tester le scanner.',
      'general','2026-06-21T14:00:00','2026-06-21T22:00:00','Centre communautaire AHH — Hamilton',
      200,'planifiee',req.user.id,10.00,1,qrToken);
    const actId = actR.lastInsertRowid;

    const all = [];
    async function mk(nom, status, payStatus, checkedIn, methode, prix, userId) {
      const token = crypto2.randomUUID();
      let barcode = _bc();
      while(db.prepare('SELECT id FROM tickets WHERE barcode_data=?').get(barcode)) barcode = _bc();
      db.prepare(`INSERT INTO tickets (activity_id,user_id,acheteur_nom,acheteur_email,qr_data,barcode_data,prix,methode_paiement,payment_status,statut,checked_in,date_checkin,vendu_par)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,${checkedIn?'CURRENT_TIMESTAMP':'NULL'},?)`).run(
        actId, userId||null, nom, 'secretaire@ahhamilton.ca', 'TICKET:'+token, barcode, prix||10,
        methode||'interac', payStatus, status, checkedIn?1:0, req.user.id);
      try {
        const qrBuf = await QRCode.toBuffer(siteBase+'/scan.html?t='+token,{type:'png',width:400,margin:2,errorCorrectionLevel:'H',color:{dark:'#1b5e20',light:'#fff'}});
        fs.writeFileSync(path.join(qrDir,token+'.png'), qrBuf);
      } catch{}
      return { nom, barcode, token, status, payStatus, checkedIn, methode: methode||'interac', prix: prix||10 };
    }

    // ═══ CATÉGORIE 1 : VALIDES — Stripe (8) ═══
    for (let i=1;i<=4;i++) all.push({cat:'✅ Stripe individuel', ...(await mk('Stripe Solo '+i,'actif','paid',false,'stripe',10))});
    for (let i=1;i<=2;i++) all.push({cat:'✅ Stripe VIP', ...(await mk('Stripe VIP '+i,'actif','paid',false,'stripe',25))});
    for (let i=1;i<=2;i++) all.push({cat:'✅ Stripe étudiant', ...(await mk('Stripe Étudiant '+i,'actif','paid',false,'stripe',5))});

    // ═══ CATÉGORIE 2 : VALIDES — Membre actif Interac (6) ═══
    for (let i=1;i<=6;i++) all.push({cat:'✅ Membre Interac', ...(await mk('Membre Interac '+i,'actif','paid',false,'interac',10))});

    // ═══ CATÉGORIE 3 : VALIDES — Cash / imprimé (6) ═══
    for (let i=1;i<=6;i++) all.push({cat:'✅ Cash comptoir', ...(await mk('Cash Comptoir '+i,'actif','paid',false,'cash',10))});

    // ═══ CATÉGORIE 4 : FAMILLE — 1 membre, 5 billets (5) ═══
    const familyUser = db.prepare("SELECT id FROM users WHERE actif=1 AND role='member' LIMIT 1").get();
    const fuid = familyUser?.id || null;
    for (let i=1;i<=5;i++) all.push({cat:'👨‍👩‍👧‍👦 Famille (5 billets)', ...(await mk('Famille Dupont — billet '+i,'actif','paid',false,'stripe',10,fuid))});

    // ═══ CATÉGORIE 5 : INCONNU achète en ligne (4) ═══
    for (let i=1;i<=4;i++) all.push({cat:'🌐 Inconnu en ligne', ...(await mk('Visiteur Anonyme '+i,'actif','paid',false,'stripe',10))});

    // ═══ CATÉGORIE 6 : DÉJÀ SCANNÉ (5) ═══
    for (let i=1;i<=5;i++) all.push({cat:'🔄 Déjà scanné', ...(await mk('Déjà Entré '+i,'actif','paid',true,'stripe',10))});

    // ═══ CATÉGORIE 7 : ANNULÉ par le comité (4) ═══
    for (let i=1;i<=4;i++) all.push({cat:'❌ Annulé', ...(await mk('Billet Annulé '+i,'annule','paid',false,'interac',10))});

    // ═══ CATÉGORIE 8 : NON PAYÉ — Interac en attente (4) ═══
    for (let i=1;i<=4;i++) all.push({cat:'❌ Non payé (Interac)', ...(await mk('Impayé Interac '+i,'genere','pending',false,'interac',10))});

    // ═══ CATÉGORIE 9 : PRÉ-IMPRIMÉ non vendu (4) ═══
    for (let i=1;i<=4;i++) all.push({cat:'❌ Pré-imprimé non vendu', ...(await mk('Talon Non-Vendu '+i,'genere','pending',false,'cash',10))});

    // ═══ CATÉGORIE 10 : PRIX DIFFÉRENTS (4) ═══
    all.push({cat:'✅ Gratuit', ...(await mk('Entrée Gratuite 1','actif','paid',false,'cash',0))});
    all.push({cat:'✅ Prix réduit', ...(await mk('Tarif Réduit 1','actif','paid',false,'stripe',3))});
    all.push({cat:'✅ Tarif groupe', ...(await mk('Groupe Église 1','actif','paid',false,'interac',7))});
    all.push({cat:'✅ Premium', ...(await mk('Place Premium 1','actif','paid',false,'stripe',50))});

    // Envoyer le courriel avec les 50 QR codes
    const secEmail = req.user.email || 'secretaire@ahhamilton.ca';
    const categories = [...new Set(all.map(t => t.cat))];

    let emailHtml = '';
    for (const cat of categories) {
      const items = all.filter(t => t.cat === cat);
      emailHtml += `<tr><td colspan="5" style="background:#1b5e20;color:#fff;padding:10px 12px;font-weight:700;font-size:.9rem">${cat} (${items.length})</td></tr>`;
      emailHtml += items.map((t,i) => `<tr style="border-bottom:1px solid #e0e0e0">
        <td style="padding:6px 10px;text-align:center;font-size:.8rem">${all.indexOf(t)+1}</td>
        <td style="padding:6px 10px;font-size:.82rem">${t.nom}</td>
        <td style="padding:6px 10px;font-family:monospace;font-weight:700;color:#1b5e20;font-size:.85rem">${t.barcode}</td>
        <td style="padding:6px 10px;font-size:.8rem">${t.methode} · $${t.prix}</td>
        <td style="padding:6px 10px;text-align:center"><img src="${siteBase}/uploads/qr/${t.token}.png" width="100" height="100" alt="QR"/></td>
      </tr>`).join('');
    }

    const summary = `<p><strong>${all.filter(t=>t.cat.startsWith('✅')).length} valides</strong> · <strong>${all.filter(t=>t.cat.includes('Famille')).length} famille</strong> · <strong>${all.filter(t=>t.cat.includes('Inconnu')).length} inconnus</strong> · <strong>${all.filter(t=>t.cat.startsWith('🔄')).length} déjà scannés</strong> · <strong>${all.filter(t=>t.cat.startsWith('❌')).length} refusés</strong></p>`;

    await mailer.sendMail({
      to: secEmail,
      subject: '🧪 TEST SCAN V2 — 50 billets de simulation | AHH',
      html: `<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
        <div style="background:#1b5e20;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="margin:0">🧪 Simulation Scanner V2 — 50 billets</h2>
          <p style="margin:8px 0 0;opacity:.8">Activité : TEST SCAN V2 · ${new Date().toLocaleDateString('fr-CA')}</p>
        </div>
        <div style="padding:20px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px">
          ${summary}
          <p style="font-size:.82rem;color:#666">Scannez les QR ci-dessous. 10 catégories de situations différentes.</p>
          <table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:.82rem">
            <thead><tr style="background:#f5f5f5">
              <th style="padding:8px;text-align:center;width:30px">#</th>
              <th style="padding:8px;text-align:left">Nom</th>
              <th style="padding:8px;text-align:left">Code</th>
              <th style="padding:8px;text-align:left">Méthode</th>
              <th style="padding:8px;text-align:center;width:110px">QR</th>
            </tr></thead>
            <tbody>${emailHtml}</tbody>
          </table>
        </div>
      </div>`
    });

    res.json({ ok:true, actId, total: all.length, categories: categories.map(c => ({ cat:c, count: all.filter(t=>t.cat===c).length })) });
  } catch(e) {
    console.error('[TEST SCAN V2]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIKES / RÉACTIONS
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/likes', authMiddleware, (req, res) => {
  const { target_type, target_id, reaction } = req.body;
  if (!target_type || !target_id) return res.status(400).json({ error: 'target_type et target_id requis' });
  const existing = db.prepare('SELECT id FROM likes WHERE user_id=? AND target_type=? AND target_id=?').get(req.user.id, target_type, target_id);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id=?').run(existing.id);
    res.json({ liked: false });
  } else {
    db.prepare('INSERT INTO likes (user_id, target_type, target_id, reaction) VALUES (?,?,?,?)').run(req.user.id, target_type, target_id, reaction || 'like');
    res.json({ liked: true });
  }
});

app.get('/api/likes', authMiddleware, (req, res) => {
  const { target_type, target_id } = req.query;
  if (!target_type || !target_id) return res.status(400).json({ error: 'target_type et target_id requis' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE target_type=? AND target_id=?').get(target_type, target_id).c;
  const liked = !!db.prepare('SELECT id FROM likes WHERE user_id=? AND target_type=? AND target_id=?').get(req.user.id, target_type, target_id);
  res.json({ count, liked });
});

app.get('/api/likes/counts', (req, res) => {
  const { target_type, ids } = req.query;
  if (!target_type || !ids) return res.status(400).json({ error: 'target_type et ids requis' });
  const idList = ids.split(',').map(Number).filter(n => n > 0);
  if (!idList.length) return res.json({});
  const result = {};
  idList.forEach(id => {
    result[id] = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE target_type=? AND target_id=?').get(target_type, id).c;
  });
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════════
// COMMENTAIRES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/comments', (req, res) => {
  const { target_type, target_id } = req.query;
  if (!target_type || !target_id) return res.status(400).json({ error: 'target_type et target_id requis' });
  const rows = db.prepare(`SELECT c.*, u.prenom, u.nom, u.photo_url FROM comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.target_type=? AND c.target_id=? ORDER BY c.date_creation ASC`).all(target_type, target_id);
  res.json(rows);
});

app.post('/api/comments', authMiddleware, (req, res) => {
  const { target_type, target_id, contenu } = req.body;
  if (!target_type || !target_id || !contenu || !contenu.trim()) return res.status(400).json({ error: 'Données manquantes' });
  const result = db.prepare('INSERT INTO comments (user_id, target_type, target_id, contenu) VALUES (?,?,?,?)').run(req.user.id, target_type, target_id, contenu.trim());
  const comment = db.prepare(`SELECT c.*, u.prenom, u.nom, u.photo_url FROM comments c
    LEFT JOIN users u ON u.id = c.user_id WHERE c.id=?`).get(result.lastInsertRowid);
  res.json(comment);
});

app.delete('/api/comments/:id', authMiddleware, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Commentaire introuvable' });
  if (comment.user_id !== req.user.id && !['admin','secretaire'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CHATBOT FAQ
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/chatbot', (req, res) => {
  const msg = (req.body.message || '').toLowerCase().trim();
  if (!msg) return res.json({ reply: 'Comment puis-je vous aider ?' });

  const faqs = [
    { keys: ['inscription','inscrire','membre','adhésion','rejoindre','join'], reply: 'Pour devenir membre, visitez notre page d\'adhésion : <a href="/adhesion.html">Devenir membre</a>. L\'inscription est simple et rapide !' },
    { keys: ['activité','événement','activite','evenement','bbq','gala'], reply: 'Consultez nos prochains événements sur la page <a href="/actualites.html">Activités</a>. Vous pouvez vous inscrire directement en ligne !' },
    { keys: ['contact','joindre','téléphone','telephone','email','courriel'], reply: 'Contactez-nous :<br>📞 905-818-8269<br>📧 info@ahhamilton.ca<br>📍 231 Fernwood Crescent, Hamilton, ON' },
    { keys: ['don','donner','donation','soutenir','supporter'], reply: 'Merci pour votre générosité ! Vous pouvez faire un don via <a href="https://donate.stripe.com/fZe9CTg1Oh0qehacMM" target="_blank">Stripe</a> ou par virement Interac.' },
    { keys: ['bénévol','benevol','volontaire','aider'], reply: 'Le bénévolat est au cœur de notre mission ! Connectez-vous à votre espace membre pour soumettre vos heures.' },
    { keys: ['horaire','heure','ouvert','quand'], reply: 'Nos événements ont lieu principalement les week-ends. Consultez le calendrier des <a href="/actualites.html">activités</a> pour les dates exactes.' },
    { keys: ['talent','annonce','service'], reply: 'Découvrez les talents de notre communauté sur <a href="/talents.html">Nos talents</a> et publiez vos annonces sur <a href="/annonces.html">Petites annonces</a>.' },
    { keys: ['galerie','photo','image'], reply: 'Revivez nos meilleurs moments sur notre <a href="/galerie.html">Galerie photos</a> !' },
    { keys: ['hamilton','ontario','canada','adresse','lieu','où','ou'], reply: 'L\'AHH est basée à Hamilton, Ontario, Canada.<br>📍 231 Fernwood Crescent, Hamilton, ON L8T 3L7' },
    { keys: ['merci','thank','mèsi'], reply: 'Avec plaisir ! N\'hésitez pas si vous avez d\'autres questions. 😊' },
    { keys: ['bonjour','salut','hello','hi','bonsoir','allo'], reply: 'Bonjour ! 👋 Comment puis-je vous aider ? Je peux répondre à vos questions sur l\'AHH, les activités, l\'inscription, et plus encore.' },
  ];

  for (const faq of faqs) {
    if (faq.keys.some(k => msg.includes(k))) return res.json({ reply: faq.reply });
  }
  res.json({ reply: 'Je ne suis pas sûr de comprendre. Essayez de me poser une question sur : les activités, l\'inscription, les contacts, les dons, ou le bénévolat. Ou contactez-nous à info@ahhamilton.ca' });
});

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR FEED (all activities)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/calendar/feed.ics', (req, res) => {
  const acts = db.prepare("SELECT * FROM activities WHERE statut IN ('planifiee','en_cours') ORDER BY date_debut").all();
  var ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//AHH//Activities//FR\r\nX-WR-CALNAME:AHH Activités\r\n';
  acts.forEach(function(a) {
    var start = (a.date_debut||'').replace(/[-:]/g,'').split('.')[0];
    var end = (a.date_fin||a.date_debut||'').replace(/[-:]/g,'').split('.')[0];
    ical += 'BEGIN:VEVENT\r\nDTSTART:' + start + '\r\nDTEND:' + end + '\r\nSUMMARY:' + (a.titre||'').replace(/[,;\\]/g,' ') + '\r\nLOCATION:' + (a.lieu||'').replace(/[,;\\]/g,' ') + '\r\nDESCRIPTION:' + (a.description||'').replace(/[,;\\]/g,' ').substring(0,200) + '\r\nEND:VEVENT\r\n';
  });
  ical += 'END:VCALENDAR';
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="ahh-activites.ics"');
  res.send(ical);
});

// ══════════════════════════════════════════════════════════════════════════════
// COVOITURAGE
// ══════════════════════════════════════════════════════════════════════════════

// GET rideshares for an activity
app.get('/api/activities/:id/rideshares', authMiddleware, (req, res) => {
  const actId = parseInt(req.params.id);
  const rows = db.prepare(`
    SELECT r.*, u.prenom, u.nom,
      (SELECT COUNT(*) FROM rideshare_requests rr WHERE rr.rideshare_id = r.id AND rr.statut = 'accepte') AS places_prises,
      (SELECT COUNT(*) FROM rideshare_requests rr WHERE rr.rideshare_id = r.id AND rr.statut = 'en_attente') AS demandes_attente
    FROM rideshares r JOIN users u ON u.id = r.user_id
    WHERE r.activity_id = ? ORDER BY r.date_creation DESC
  `).all(actId);
  // Ajouter les demandes de l'utilisateur courant
  rows.forEach(r => {
    r.my_request = db.prepare('SELECT * FROM rideshare_requests WHERE rideshare_id = ? AND user_id = ?').get(r.id, req.user.id) || null;
  });
  res.json(rows);
});

// POST create rideshare offer/request
app.post('/api/rideshares', authMiddleware, (req, res) => {
  const { activity_id, type, depart, places, heure_depart, note } = req.body;
  if (!activity_id) return res.status(400).json({ error: 'activity_id requis' });
  const r = db.prepare(`INSERT INTO rideshares (activity_id, user_id, type, depart, places, heure_depart, note) VALUES (?,?,?,?,?,?,?)`)
    .run(activity_id, req.user.id, type || 'offer', depart || '', parseInt(places) || 1, heure_depart || '', note || '');
  res.status(201).json({ id: r.lastInsertRowid });
});

// POST request a seat
app.post('/api/rideshares/:id/request', authMiddleware, (req, res) => {
  const rsId = parseInt(req.params.id);
  const rs = db.prepare('SELECT * FROM rideshares WHERE id = ?').get(rsId);
  if (!rs) return res.status(404).json({ error: 'Covoiturage introuvable' });
  if (rs.user_id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas demander une place dans votre propre covoiturage' });
  const existing = db.prepare('SELECT * FROM rideshare_requests WHERE rideshare_id = ? AND user_id = ?').get(rsId, req.user.id);
  if (existing) return res.status(409).json({ error: 'Demande déjà envoyée' });
  const r = db.prepare("INSERT INTO rideshare_requests (rideshare_id, user_id, statut) VALUES (?,?,'en_attente')").run(rsId, req.user.id);
  // Notifier le conducteur
  try {
    const requester = db.prepare('SELECT prenom, nom FROM users WHERE id = ?').get(req.user.id);
    db.prepare("INSERT INTO alerts (type, titre, contenu, destinataire_id, source_id) VALUES (?,?,?,?,?)")
      .run('covoiturage', 'Demande de covoiturage', `${requester.prenom} ${requester.nom} souhaite rejoindre votre covoiturage.`, rs.user_id, rsId);
  } catch(_) {}
  res.status(201).json({ id: r.lastInsertRowid });
});

// PUT accept/reject a request
app.put('/api/rideshares/:id/requests/:reqId', authMiddleware, (req, res) => {
  const rsId = parseInt(req.params.id);
  const reqId = parseInt(req.params.reqId);
  const { statut } = req.body;
  if (!['accepte', 'refuse'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const rs = db.prepare('SELECT * FROM rideshares WHERE id = ?').get(rsId);
  if (!rs) return res.status(404).json({ error: 'Covoiturage introuvable' });
  if (rs.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  db.prepare('UPDATE rideshare_requests SET statut = ? WHERE id = ?').run(statut, reqId);
  // Notifier le demandeur
  try {
    const rr = db.prepare('SELECT * FROM rideshare_requests WHERE id = ?').get(reqId);
    if (rr) {
      const msg = statut === 'accepte' ? 'Votre demande de covoiturage a été acceptée !' : 'Votre demande de covoiturage a été refusée.';
      db.prepare("INSERT INTO alerts (type, titre, contenu, destinataire_id, source_id) VALUES (?,?,?,?,?)")
        .run('covoiturage', 'Réponse covoiturage', msg, rr.user_id, rsId);
    }
  } catch(_) {}
  res.json({ ok: true });
});

// GET requests for a rideshare (owner only)
app.get('/api/rideshares/:id/requests', authMiddleware, (req, res) => {
  const rsId = parseInt(req.params.id);
  const rs = db.prepare('SELECT * FROM rideshares WHERE id = ?').get(rsId);
  if (!rs) return res.status(404).json({ error: 'Covoiturage introuvable' });
  if (rs.user_id !== req.user.id && !['admin', 'secretaire'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  const rows = db.prepare(`SELECT rr.*, u.prenom, u.nom, u.telephone FROM rideshare_requests rr
    JOIN users u ON u.id = rr.user_id WHERE rr.rideshare_id = ? ORDER BY rr.date_demande ASC`).all(rsId);
  res.json(rows);
});

// DELETE own rideshare
app.delete('/api/rideshares/:id', authMiddleware, (req, res) => {
  const rsId = parseInt(req.params.id);
  const rs = db.prepare('SELECT * FROM rideshares WHERE id = ?').get(rsId);
  if (!rs) return res.status(404).json({ error: 'Covoiturage introuvable' });
  if (rs.user_id !== req.user.id && !['admin', 'secretaire'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  db.prepare('DELETE FROM rideshares WHERE id = ?').run(rsId);
  res.json({ ok: true });
});

// ── Multer : shop product images ────────────────────────────────────────────
const shopStorage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname,'uploads','shop'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`)
});
const uploadShop = multer({ storage: shopStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════════════════════════════════════════════════════
// ── BOUTIQUE EN LIGNE ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Public — liste des produits actifs
app.get('/api/shop/products', (req, res) => {
  const rows = db.prepare("SELECT * FROM shop_products WHERE actif=1 ORDER BY date_creation DESC").all();
  res.json(rows);
});

// Public — un produit
app.get('/api/shop/products/:id', (req, res) => {
  const p = db.prepare("SELECT * FROM shop_products WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  res.json(p);
});

// Admin — tous les produits (y compris inactifs)
app.get('/api/shop/products-all', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const rows = db.prepare("SELECT sp.*, u.prenom || ' ' || u.nom AS cree_par_nom FROM shop_products sp LEFT JOIN users u ON sp.cree_par=u.id ORDER BY sp.date_creation DESC").all();
  res.json(rows);
});

// Créer un produit
app.post('/api/shop/products', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), uploadShop.single('image'), (req, res) => {
  const { nom, description, prix, categorie, stock } = req.body;
  if (!nom || !prix) return res.status(400).json({ error: 'Nom et prix requis' });
  const image_path = req.file ? '/uploads/shop/' + req.file.filename : null;
  const r = db.prepare("INSERT INTO shop_products (nom,description,prix,image_path,categorie,stock,cree_par) VALUES (?,?,?,?,?,?,?)").run(
    nom, description || null, parseFloat(prix), image_path, categorie || 'general', parseInt(stock) || 0, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// Modifier un produit
app.put('/api/shop/products/:id', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), uploadShop.single('image'), (req, res) => {
  const prev = db.prepare("SELECT * FROM shop_products WHERE id=?").get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Produit introuvable' });
  const { nom, description, prix, categorie, stock, actif } = req.body;
  const image_path = req.file ? '/uploads/shop/' + req.file.filename : prev.image_path;
  db.prepare("UPDATE shop_products SET nom=?,description=?,prix=?,image_path=?,categorie=?,stock=?,actif=? WHERE id=?").run(
    nom || prev.nom, description !== undefined ? description : prev.description,
    prix !== undefined ? parseFloat(prix) : prev.prix, image_path,
    categorie || prev.categorie, stock !== undefined ? parseInt(stock) : prev.stock,
    actif !== undefined ? parseInt(actif) : prev.actif, req.params.id);
  res.json({ ok: true });
});

// Supprimer un produit
app.delete('/api/shop/products/:id', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const prev = db.prepare("SELECT * FROM shop_products WHERE id=?").get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Produit introuvable' });
  db.prepare("DELETE FROM shop_products WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Créer une commande (authentifié)
app.post('/api/shop/orders', authMiddleware, (req, res) => {
  const { items, acheteur_nom, acheteur_email, acheteur_telephone, methode } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Panier vide' });
  let total = 0;
  const resolved = [];
  for (const it of items) {
    const p = db.prepare("SELECT * FROM shop_products WHERE id=? AND actif=1").get(it.product_id);
    if (!p) return res.status(400).json({ error: 'Produit introuvable: ' + it.product_id });
    if (p.stock > 0 && p.stock < (it.quantite || 1)) return res.status(400).json({ error: 'Stock insuffisant pour ' + p.nom });
    total += p.prix * (it.quantite || 1);
    resolved.push({ ...it, prix_unitaire: p.prix });
  }
  const r = db.prepare("INSERT INTO shop_orders (user_id,acheteur_nom,acheteur_email,acheteur_telephone,total,methode) VALUES (?,?,?,?,?,?)").run(
    req.user.id, acheteur_nom || (req.user.prenom + ' ' + req.user.nom), acheteur_email || req.user.email,
    acheteur_telephone || '', total, methode || 'interac');
  const orderId = r.lastInsertRowid;
  for (const it of resolved) {
    db.prepare("INSERT INTO shop_order_items (order_id,product_id,quantite,prix_unitaire) VALUES (?,?,?,?)").run(
      orderId, it.product_id, it.quantite || 1, it.prix_unitaire);
    const p = db.prepare("SELECT stock FROM shop_products WHERE id=?").get(it.product_id);
    if (p && p.stock > 0) db.prepare("UPDATE shop_products SET stock=stock-? WHERE id=?").run(it.quantite || 1, it.product_id);
  }
  res.json({ ok: true, id: orderId, total });
});

// Liste des commandes (admin)
app.get('/api/shop/orders', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const orders = db.prepare("SELECT o.*, u.prenom || ' ' || u.nom AS user_nom FROM shop_orders o LEFT JOIN users u ON o.user_id=u.id ORDER BY o.date_commande DESC").all();
  for (const o of orders) {
    o.items = db.prepare("SELECT oi.*, sp.nom AS produit_nom FROM shop_order_items oi JOIN shop_products sp ON oi.product_id=sp.id WHERE oi.order_id=?").all(o.id);
  }
  res.json(orders);
});

// Modifier le statut d'une commande
app.put('/api/shop/orders/:id/status', authMiddleware, requireRole('admin','secretaire','tresoriere','delegue'), (req, res) => {
  const { statut } = req.body;
  const valid = ['en_attente', 'confirmee', 'expediee', 'livree', 'annulee'];
  if (!valid.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const o = db.prepare("SELECT * FROM shop_orders WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Commande introuvable' });
  db.prepare("UPDATE shop_orders SET statut=? WHERE id=?").run(statut, req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── DONS RÉCURRENTS STRIPE ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/donations/recurring', async (req, res) => {
  const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });
  const { montant, email } = req.body;
  if (!montant || montant < 1) return res.status(400).json({ error: 'Montant minimum 1$' });
  try {
    const stripe = require('stripe')(stripeKey);
    const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price_data: { currency:'cad', product_data:{name:'Don mensuel — AHH'}, unit_amount:Math.round(montant*100), recurring:{interval:'month'} }, quantity:1 }],
      success_url: siteUrl + '/index.html?donation=merci',
      cancel_url: siteUrl + '/index.html#don',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe recurring donation error:', err.message);
    res.status(500).json({ error: 'Erreur Stripe: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── COMMANDITES AUTOMATISÉES ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/sponsoring/checkout', async (req, res) => {
  const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });
  const { tier, company_name, email, website } = req.body;
  const prices = { bronze:10000, argent:25000, or:50000, platine:100000 };
  if (!prices[tier]) return res.status(400).json({ error: 'Tier invalide' });
  try {
    const stripe = require('stripe')(stripeKey);
    const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], mode: 'payment',
      customer_email: email,
      line_items: [{ price_data: { currency:'cad', product_data:{name:'Commandite ' + tier.charAt(0).toUpperCase()+tier.slice(1) + ' — AHH', description:'Commandite annuelle pour ' + company_name}, unit_amount:prices[tier] }, quantity:1 }],
      metadata: { type:'commandite', tier, company_name, email, website: website || '' },
      success_url: siteUrl + '/index.html?sponsor=merci',
      cancel_url: siteUrl + '/index.html',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe sponsoring checkout error:', err.message);
    res.status(500).json({ error: 'Erreur Stripe: ' + err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route introuvable' });
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ AHH Server démarré sur http://localhost:${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/dashboard/login.html`);
  console.log(`   API       : http://localhost:${PORT}/api/\n`);
});
