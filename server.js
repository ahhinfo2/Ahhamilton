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
 'uploads/payments','uploads/talents','uploads/annonces','uploads/attachments']
  .forEach(d => { const p = path.join(__dirname, d); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); });

const db = require('./db/database');
const { authMiddleware, requireRole, JWT_SECRET } = require('./middleware/auth');
const mailer = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3001;
console.log(`Starting AHH server on PORT=${PORT}`);

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
    const email    = session.customer_details?.email || '';
    const montant  = (session.amount_total || 0) / 100;
    const ref      = session.payment_intent || session.id;
    const mois     = new Date().toISOString().substring(0, 7);

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

    console.log(`✅ Stripe don enregistré : ${email} — $${montant}`);
  }

  res.json({ received: true });
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
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

// ── Helper ──────────────────────────────────────────────────────────────────
function createAlert(destinataireId, type, titre, contenu, sourceId = null) {
  db.prepare(`INSERT INTO alerts (destinataire_id, type, titre, contenu, source_id)
              VALUES (?, ?, ?, ?, ?)`).run(destinataireId, type, titre, contenu, sourceId);
}

function getAdminsAndRole(role) {
  return db.prepare(`SELECT id FROM users WHERE role = ? AND actif = 1`).all(role);
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
    { id: user.id, email: user.email, role: user.role, prenom: user.prenom, nom: user.nom },
    JWT_SECRET, { expiresIn: '24h' }
  );
  const { password_hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// Inscription publique → demande en attente (pending_registrations)
app.post('/api/auth/register', (req, res) => {
  const { prenom, nom, email, telephone, adresse, date_naissance, password, plan, message, source } = req.body;
  if (!prenom || !nom || !email || !password)
    return res.status(400).json({ error: 'Champs requis manquants' });

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  if (db.prepare('SELECT id FROM pending_registrations WHERE email = ? AND statut = ?').get(email, 'en_attente'))
    return res.status(409).json({ error: 'Une demande est déjà en cours pour cet email' });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO pending_registrations
    (prenom, nom, email, telephone, adresse, date_naissance, password_hash, plan, message, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(prenom, nom, email, telephone||'', adresse||'', date_naissance||'', hash,
         plan||'gratuit', message||'', source||'');

  // Notifier tous les exécutifs
  const staff = db.prepare("SELECT id FROM users WHERE role IN ('admin','tresoriere','secretaire','delegue') AND actif=1").all();
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
  }
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

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { password_hash, ...safe } = user;
  res.json(safe);
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
    date_inscription, date_naissance, bio, photo_url FROM users ORDER BY nom, prenom`).all();
  res.json(rows);
});

app.get('/api/users/:id', authMiddleware, (req, res) => {
  const u = db.prepare(`SELECT id, prenom, nom, email, telephone, adresse, role, actif,
    plan, plan_paid_month, plan_unpaid_count,
    date_inscription, date_naissance, bio, photo_url FROM users WHERE id = ?`).get(req.params.id);
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

app.put('/api/users/:id', authMiddleware, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const isSelf  = req.user.id === parseInt(req.params.id);
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'Accès refusé' });

  const { prenom, nom, email, telephone, adresse, date_naissance, role, actif, bio } = req.body;
  const updates = []; const vals = [];
  if (prenom)        { updates.push('prenom = ?');        vals.push(prenom); }
  if (nom)           { updates.push('nom = ?');           vals.push(nom); }
  if (email)         { updates.push('email = ?');         vals.push(email); }
  if (telephone !== undefined) { updates.push('telephone = ?'); vals.push(telephone); }
  if (adresse !== undefined)   { updates.push('adresse = ?');   vals.push(adresse); }
  if (date_naissance !== undefined) { updates.push('date_naissance = ?'); vals.push(date_naissance); }
  if (bio !== undefined)       { updates.push('bio = ?');       vals.push(bio); }
  if (isAdmin && role !== undefined)  { updates.push('role = ?');  vals.push(role); }
  if (isAdmin && actif !== undefined) { updates.push('actif = ?'); vals.push(actif); }

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

app.delete('/api/users/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE users SET actif = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Membre désactivé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVITIES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/activities', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.prenom || ' ' || u.nom AS createur,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = a.id) AS nb_inscrits,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = a.id AND user_id = ?) AS user_registered
    FROM activities a LEFT JOIN users u ON u.id = a.cree_par ORDER BY a.date_debut DESC
  `).all(req.user.id);
  res.json(rows);
});

const ACTIVITY_ROLES = ['admin','tresoriere','secretaire','delegue'];
const DISCOUNT_ROLES  = ['admin']; // VP = admin role, Présidente = admin role

const crypto2 = require('crypto');
const QRCode  = require('qrcode');

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

app.delete('/api/activities/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE activities SET statut = ? WHERE id = ?').run('annulee', req.params.id);
  res.json({ message: 'Activité annulée' });
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
    SELECT fl.*, a.titre AS activite,
      COALESCE((SELECT SUM(t.montant) FROM transactions t WHERE t.financial_line_id = fl.id AND t.type = 'depense'), 0) AS depenses,
      COALESCE((SELECT SUM(t.montant) FROM transactions t WHERE t.financial_line_id = fl.id AND t.type = 'revenu'), 0) AS revenus
    FROM financial_lines fl LEFT JOIN activities a ON a.id = fl.activity_id ORDER BY fl.date_creation DESC
  `).all();
  res.json(rows);
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
  db.prepare('UPDATE invoices SET statut = ? WHERE id = ?').run(statut, req.params.id);
  res.json({ message: 'Mise à jour' });
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
    targets = db.prepare('SELECT id FROM users WHERE actif = 1 AND id != ?').all(req.user.id).map(u => u.id);
  } else if (destinataires[0] === 'members') {
    targets = db.prepare("SELECT id FROM users WHERE role = 'member' AND actif = 1").all().map(u => u.id);
  } else {
    targets = destinataires;
  }

  const r = db.prepare('INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?, ?, ?, ?)')
    .run(req.user.id, sujet||'', contenu, targets.length > 1 ? 'rafale' : 'individuel');

  const ins = db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?, ?)');
  targets.forEach(id => ins.run(r.lastInsertRowid, id));
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
  db.prepare(`UPDATE volunteer_hours SET statut = ?, approuve_par = ?, date_approbation = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(statut, req.user.id, req.params.id);
  res.json({ message: 'Statut mis à jour' });
});

app.delete('/api/volunteer/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM volunteer_hours WHERE id = ?').run(req.params.id);
  res.json({ message: 'Supprimé' });
});

// ══════════════════════════════════════════════════════════════════════════════
// MEETING NOTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/notes', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT n.*, u.prenom || ' ' || u.nom AS auteur, a.titre AS activite
    FROM meeting_notes n LEFT JOIN users u ON u.id = n.auteur_id LEFT JOIN activities a ON a.id = n.activity_id
    WHERE n.auteur_id = ? OR ? IN ('admin','secretaire','tresoriere','delegue')
    ORDER BY n.date_reunion DESC`).all(req.user.id, req.user.role);
  res.json(rows);
});

app.post('/api/notes', authMiddleware, (req, res) => {
  const { titre, contenu, langue, date_reunion, activity_id } = req.body;
  const r = db.prepare(`INSERT INTO meeting_notes (auteur_id, titre, contenu, langue, date_reunion, activity_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, titre||'Sans titre', contenu||'', langue||'fr', date_reunion||'', activity_id||null);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/notes/:id', authMiddleware, (req, res) => {
  const { titre, contenu, contenu_corrige, langue } = req.body;
  db.prepare(`UPDATE meeting_notes SET titre=?, contenu=?, contenu_corrige=?, langue=?, date_modification=CURRENT_TIMESTAMP WHERE id=?`)
    .run(titre||'', contenu||'', contenu_corrige||null, langue||'fr', req.params.id);
  res.json({ message: 'Note mise à jour' });
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
  const { nom, description, responsable_id, date_debut, date_fin } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare(`INSERT INTO projects (nom, description, responsable_id, date_debut, date_fin) VALUES (?, ?, ?, ?, ?)`)
    .run(nom, description||'', responsable_id||null, date_debut||'', date_fin||'');
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/projects/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const { nom, description, statut, progression, date_debut, date_fin } = req.body;
  db.prepare(`UPDATE projects SET nom=?, description=?, statut=?, progression=?, date_debut=?, date_fin=? WHERE id=?`)
    .run(nom||'', description||'', statut||'en_cours', progression||0, date_debut||'', date_fin||'', req.params.id);
  res.json({ message: 'Mis à jour' });
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
    FROM users u WHERE u.actif = 1 ORDER BY u.nom`).all();
  res.json(members);
});

// ── Stats publiques (pour la page d'accueil) ─────────────────────────────────
app.get('/api/stats/public', (req, res) => {
  res.json({
    membres:    db.prepare("SELECT COUNT(*) AS c FROM users WHERE actif=1").get().c,
    activites:  db.prepare("SELECT COUNT(*) AS c FROM activities WHERE statut != 'annulee'").get().c,
    benevoles:  db.prepare("SELECT COALESCE(SUM(heures),0) AS c FROM volunteer_hours WHERE statut='approuve'").get().c,
    annees:     17,
  });
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
    prochaines_activites: db.prepare("SELECT titre, date_debut, lieu FROM activities WHERE statut='planifiee' ORDER BY date_debut LIMIT 3").all(),
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

  const since = req.query.since || '1970-01-01';
  const msgs = db.prepare(`
    SELECT cm.*, u.prenom, u.nom, u.role
    FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
    WHERE cm.room_id = ? AND cm.created_at > ?
    ORDER BY cm.created_at ASC LIMIT 100
  `).all(req.params.id, since);

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

app.get('/api/activities/public', (req, res) => {
  const rows = db.prepare(`
    SELECT id, titre, description, type, date_debut, date_fin, lieu, max_participants, statut,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id = activities.id) AS nb_inscrits
    FROM activities WHERE statut IN ('planifiee','en_cours')
    ORDER BY date_debut ASC
  `).all();
  res.json(rows);
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
}

// Lancer le job renouvellements toutes les 24h
setTimeout(() => { runRenewalJob(); setInterval(runRenewalJob, 24 * 60 * 60 * 1000); }, 60000);

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

  const r = db.prepare('INSERT INTO tax_receipts (user_id, annee, montant_total, genere_par, contenu) VALUES (?,?,?,?,?)')
    .run(user_id, annee, total, req.user.id, contenu);

  // Envoyer le reçu au membre
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(req.user.id, `🧾 Votre reçu fiscal ${annee} — AHH`, contenu);
  db.prepare('INSERT INTO message_recipients (message_id, destinataire_id) VALUES (?,?)').run(msgR.lastInsertRowid, user_id);
  createAlert(user_id, 'paiement', `🧾 Reçu fiscal ${annee} disponible`, `Total: $${total.toFixed(2)}`);
  mailer.sendRecuFiscal(u, annee, total, r.lastInsertRowid).catch(()=>{});

  res.status(201).json({ id: r.lastInsertRowid, montant_total: total, contenu });
});

// Reçu fiscal — page HTML imprimable (protégée par token)
app.get('/api/receipts/:id/print', authMiddleware, (req, res) => {
  const r = db.prepare(`SELECT tr.*, u.prenom, u.nom, u.email, u.adresse, u.telephone,
    g.prenom AS gen_prenom, g.nom AS gen_nom
    FROM tax_receipts tr
    JOIN users u ON u.id = tr.user_id
    LEFT JOIN users g ON g.id = tr.genere_par
    WHERE tr.id = ?`).get(req.params.id);
  if (!r) return res.status(404).send('Reçu introuvable');
  if (req.user.role !== 'admin' && req.user.role !== 'tresoriere' && req.user.id !== r.user_id)
    return res.status(403).send('Accès refusé');

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
    <div class="logo-block"><img src="/Public/logo.jpg" alt="AHH"/></div>
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

// PATCH plan utilisateur (admin only)
app.patch('/api/users/:id/plan', authMiddleware, requireRole('admin'), (req, res) => {
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

// Génère le QR code SVG avec logo centré — route PUBLIQUE (img tag ne peut pas envoyer auth header)
app.get('/api/activities/:id/qr', async (req, res) => {
  const act = db.prepare('SELECT id, titre, qr_token FROM activities WHERE id = ?').get(req.params.id);
  if (!act || !act.qr_token) return res.status(404).send('QR non disponible');

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url     = `${baseUrl}/activity-checkout.html?actid=${act.id}&token=${act.qr_token}`;
  const logoPath = path.join(__dirname, 'Public', 'logo1.png');

  try {
    // Générer QR en SVG avec couleur verte AHH
    const svgRaw = await QRCode.toString(url, {
      type: 'svg', width: 300, margin: 2,
      color: { dark: '#1b5e20', light: '#ffffff' }
    });

    // Extraire la taille réelle du viewBox
    const vbMatch = svgRaw.match(/viewBox="0 0 (\d+) (\d+)"/);
    const vbSize  = vbMatch ? parseInt(vbMatch[1]) : 37;

    let svgFinal = svgRaw;
    if (fs.existsSync(logoPath)) {
      const logo64   = fs.readFileSync(logoPath).toString('base64');
      const logoSize = Math.round(vbSize * 0.22);  // 22% de la taille du QR
      const pad      = Math.round(vbSize * 0.035);
      const x        = Math.round((vbSize - logoSize) / 2);
      const y        = Math.round((vbSize - logoSize) / 2);

      // Ajouter xmlns:xlink pour compatibilité SVG maximale
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

  // Message de confirmation au membre
  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id || 1;
  const msgR = db.prepare("INSERT INTO messages (expediteur_id, sujet, contenu, type) VALUES (?,?,?,'individuel')")
    .run(adminId,
      `✅ Paiement confirmé — ${act.titre}`,
      `Bonjour ${user.prenom},\n\nVotre paiement pour l'activité « ${act.titre} » a été enregistré.\n\nMontant : $${montant.toFixed(2)}\nDate de l'activité : ${act.date_debut}\nLieu : ${act.lieu||'–'}\n\nMerci de votre participation !`);
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
// RAPPORTS AVANCÉS
// ══════════════════════════════════════════════════════════════════════════════

const REPORT_ROLES = ['admin','tresoriere','secretaire','delegue'];

// Rapport activité : inscrits, payés, non payés, revenus
app.get('/api/reports/activity/:id', authMiddleware, requireRole(...REPORT_ROLES), (req, res) => {
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!act) return res.status(404).json({ error: 'Activité introuvable' });

  const inscrits = db.prepare(`
    SELECT ar.*, u.prenom, u.nom, u.email, u.plan
    FROM activity_registrations ar JOIN users u ON u.id = ar.user_id
    WHERE ar.activity_id = ? ORDER BY u.nom
  `).all(req.params.id);

  const totalRevenu = inscrits.filter(r => r.paye).reduce((s, r) => s + (r.montant_paye||0), 0);
  res.json({ activite: act, inscrits, totalRevenu, nbPayes: inscrits.filter(r=>r.paye).length, nbNonPayes: inscrits.filter(r=>!r.paye).length });
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
    WHERE u.actif = 1 GROUP BY u.id ORDER BY u.role, u.nom
  `).all();
  res.json(rows.map(u => { const {password_hash,...safe}=u; return safe; }));
});

// ── Debug temporaire : voir tous les paiements (à supprimer après test) ───
app.get('/api/debug/payments', (req, res) => {
  const rows = db.prepare('SELECT * FROM payments ORDER BY date_soumission DESC LIMIT 20').all();
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// 404 HANDLER
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
