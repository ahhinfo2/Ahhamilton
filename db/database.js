const { Database: _DB } = require('node-sqlite3-wasm');
const bcrypt = require('bcryptjs');
const path = require('path');

// Wrapper de compatibilité : node-sqlite3-wasm attend un tableau,
// better-sqlite3 (l'ancienne API) passait des arguments variadiques.
function wrapStmt(stmt) {
  const normalize = (args) => args.length > 1 ? args : args[0];
  const origRun = stmt.run.bind(stmt);
  const origGet = stmt.get.bind(stmt);
  const origAll = stmt.all.bind(stmt);
  stmt.run = (...a) => origRun(normalize(a));
  stmt.get = (...a) => origGet(normalize(a));
  stmt.all = (...a) => origAll(normalize(a));
  return stmt;
}

class Database extends _DB {
  prepare(sql) { return wrapStmt(super.prepare(sql)); }
}

// DB_PATH peut être forcé par variable d'environnement (production/Render)
const fs2 = require('fs');
let DB_PATH;
if (process.env.DB_PATH) {
  DB_PATH = process.env.DB_PATH;
} else {
  const DB_DIR = path.join(process.env.LOCALAPPDATA || process.env.HOME || __dirname, 'ahh-hamilton');
  if (!fs2.existsSync(DB_DIR)) fs2.mkdirSync(DB_DIR, { recursive: true });
  DB_PATH = path.join(DB_DIR, 'ahh.db');
}
// Nettoyer les fichiers WAL/SHM laissés par un crash précédent
[DB_PATH + '-wal', DB_PATH + '-shm', DB_PATH + '.lock'].forEach(f => {
  try {
    const stat = fs2.statSync(f);
    if (stat.isDirectory()) fs2.rmdirSync(f, { recursive: true });
    else fs2.unlinkSync(f);
    console.log(`[DB] Fichier verrou supprimé : ${f}`);
  } catch {}
});

const db = new Database(DB_PATH);

db.exec('PRAGMA journal_mode = DELETE'); // Pas de WAL — plus simple et sans fichiers résiduels
db.exec('PRAGMA busy_timeout = 15000');  // Attendre jusqu'à 15s si la DB est occupée
db.exec('PRAGMA foreign_keys = ON');
// Migrations silencieuses
try { db.exec('ALTER TABLE message_recipients ADD COLUMN supprime INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN supprime_sent INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN attachment_path TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN attachment_name TEXT'); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
)`); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN plan TEXT DEFAULT \'gratuit\''); } catch {}
try { db.exec('ALTER TABLE talents ADD COLUMN statut TEXT DEFAULT \'approuve\''); } catch {}
try { db.exec('ALTER TABLE annonces ADD COLUMN statut TEXT DEFAULT \'approuve\''); } catch {}
try { db.exec('ALTER TABLE talents ADD COLUMN notif_renouv INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE annonces ADD COLUMN notif_renouv INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE talents ADD COLUMN retrait_satisfait INTEGER'); } catch {}
try { db.exec('ALTER TABLE talents ADD COLUMN retrait_raison TEXT'); } catch {}
try { db.exec('ALTER TABLE annonces ADD COLUMN retrait_vendu INTEGER'); } catch {}
try { db.exec('ALTER TABLE annonces ADD COLUMN retrait_raison TEXT'); } catch {}
// Gestion financière membres
try { db.exec('ALTER TABLE users ADD COLUMN plan_unpaid_count INTEGER DEFAULT 0'); } catch {}
// Activités payantes avec QR
try { db.exec('ALTER TABLE activities ADD COLUMN prix REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN paiement_requis INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN rabais_json TEXT DEFAULT \'{}\''); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN qr_token TEXT'); } catch {}
// Paiement des inscriptions
try { db.exec('ALTER TABLE activity_registrations ADD COLUMN paye INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activity_registrations ADD COLUMN montant_paye REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activity_registrations ADD COLUMN date_paiement TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN plan_paid_month TEXT'); } catch {}  // 'YYYY-MM' du dernier paiement approuvé
// Billets : champ check-in
try { db.exec('ALTER TABLE tickets ADD COLUMN checked_in INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN date_checkin TEXT'); } catch {}
// Check-in pour inscriptions sans billet
try { db.exec('ALTER TABLE activity_registrations ADD COLUMN checked_in INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activity_registrations ADD COLUMN date_checkin TEXT'); } catch {}
try { db.exec('ALTER TABLE financial_lines ADD COLUMN commanditaires REAL DEFAULT 0'); } catch {}
// Types de billets par activité (adulte, enfant, VIP, etc.)
try { db.exec(`CREATE TABLE IF NOT EXISTS activity_ticket_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  prix REAL NOT NULL DEFAULT 0,
  capacite_max INTEGER DEFAULT 0,
  nb_vendus INTEGER DEFAULT 0,
  actif INTEGER DEFAULT 1,
  ordre INTEGER DEFAULT 0
)`); } catch {}
// Colonnes supplémentaires sur tickets pour achats en ligne
try { db.exec('ALTER TABLE tickets ADD COLUMN ticket_type_id INTEGER REFERENCES activity_ticket_types(id)'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN order_token TEXT'); } catch {}
try { db.exec("ALTER TABLE tickets ADD COLUMN payment_status TEXT DEFAULT 'paid'"); } catch {}
// Projets avec budget et ligne financière
try { db.exec('ALTER TABLE projects ADD COLUMN budget_prevu REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE projects ADD COLUMN notes TEXT'); } catch {}
// Email organisationnel par membre du comité
try { db.exec('ALTER TABLE users ADD COLUMN email_org TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN smtp_pass_org TEXT'); } catch {}
// Notifications SMS
try { db.exec("ALTER TABLE users ADD COLUMN operateur TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN sms_notifs INTEGER DEFAULT 1"); } catch {}
// Historique courriels externes
try { db.exec(`CREATE TABLE IF NOT EXISTS emails_externes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expediteur_id INTEGER REFERENCES users(id),
  expediteur_nom TEXT,
  expediteur_email TEXT,
  destinataire TEXT NOT NULL,
  sujet TEXT NOT NULL,
  corps TEXT NOT NULL,
  statut TEXT DEFAULT 'envoye',
  date_envoi TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
// Ligne financière liée à un projet
try { db.exec('ALTER TABLE financial_lines ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE'); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prenom TEXT NOT NULL, nom TEXT NOT NULL,
  email TEXT NOT NULL, telephone TEXT, adresse TEXT, date_naissance TEXT,
  password_hash TEXT NOT NULL, plan TEXT DEFAULT 'gratuit',
  message TEXT, source TEXT,
  statut TEXT DEFAULT 'en_attente',
  traite_par INTEGER REFERENCES users(id),
  date_soumission TEXT DEFAULT CURRENT_TIMESTAMP,
  date_traitement TEXT
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  montant REAL NOT NULL,
  type TEXT DEFAULT 'mensualite',  -- mensualite | don
  mois TEXT,                        -- YYYY-MM pour mensualité
  methode TEXT DEFAULT 'virement',
  reference TEXT,
  proof_path TEXT,
  note TEXT,
  statut TEXT DEFAULT 'en_attente', -- en_attente | approuve | rejete
  approuve_par INTEGER REFERENCES users(id),
  date_soumission TEXT DEFAULT CURRENT_TIMESTAMP,
  date_approbation TEXT
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS tax_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  annee INTEGER NOT NULL,
  montant_total REAL NOT NULL,
  genere_par INTEGER REFERENCES users(id),
  contenu TEXT,
  date_generation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS talents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  nom TEXT NOT NULL,
  categorie TEXT NOT NULL,
  specialite TEXT,
  description TEXT,
  telephone TEXT,
  adresse TEXT,
  site_web TEXT,
  photo_path TEXT,
  actif INTEGER DEFAULT 1,
  statut TEXT DEFAULT 'approuve',
  notif_renouv INTEGER DEFAULT 0,
  retrait_raison TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS annonces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  titre TEXT NOT NULL,
  description TEXT,
  prix REAL,
  gratuit INTEGER DEFAULT 0,
  type TEXT DEFAULT 'vente',
  categorie TEXT DEFAULT 'general',
  telephone TEXT,
  actif INTEGER DEFAULT 1,
  statut TEXT DEFAULT 'approuve',
  notif_renouv INTEGER DEFAULT 0,
  retrait_vendu INTEGER,
  retrait_raison TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS annonce_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annonce_id INTEGER REFERENCES annonces(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  ordre INTEGER DEFAULT 0
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prenom TEXT NOT NULL,
  nom TEXT,
  description TEXT,
  texte TEXT NOT NULL,
  actif INTEGER DEFAULT 1,
  ordre INTEGER DEFAULT 0,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  youtube_url TEXT NOT NULL,
  actif INTEGER DEFAULT 1,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS activity_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  ordre INTEGER DEFAULT 0,
  cree_par INTEGER REFERENCES users(id),
  date_upload TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec('ALTER TABLE tax_receipts ADD COLUMN mode_emission TEXT DEFAULT \'manuel\''); } catch {}
try { db.exec('ALTER TABLE tax_receipts ADD COLUMN stripe_payment_id TEXT'); } catch {}

// Forum communautaire
try { db.exec(`CREATE TABLE IF NOT EXISTS forum_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  categorie TEXT DEFAULT 'general',
  auteur_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  epingle INTEGER DEFAULT 0,
  ferme INTEGER DEFAULT 0,
  nb_vues INTEGER DEFAULT 0,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_derniere_activite TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS forum_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
  auteur_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contenu TEXT NOT NULL,
  modifie INTEGER DEFAULT 0,
  date_modification TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
// Newsletter: track sends
try { db.exec(`CREATE TABLE IF NOT EXISTS newsletter_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expediteur_id INTEGER REFERENCES users(id),
  sujet TEXT NOT NULL,
  corps TEXT NOT NULL,
  nb_destinataires INTEGER DEFAULT 0,
  segment TEXT DEFAULT 'tous',
  date_envoi TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`ALTER TABLE newsletter_sends ADD COLUMN archive INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN phantom INTEGER DEFAULT 0`); } catch {}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prenom TEXT NOT NULL,
      nom TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      telephone TEXT,
      adresse TEXT,
      date_naissance TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      actif INTEGER DEFAULT 1,
      date_inscription TEXT DEFAULT CURRENT_TIMESTAMP,
      photo_url TEXT,
      bio TEXT,
      plan TEXT DEFAULT 'gratuit',
      plan_unpaid_count INTEGER DEFAULT 0,
      plan_paid_month TEXT
    );

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titre TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'general',
      date_debut TEXT,
      date_fin TEXT,
      lieu TEXT,
      budget_prevu REAL DEFAULT 0,
      max_participants INTEGER,
      statut TEXT DEFAULT 'planifiee',
      cree_par INTEGER REFERENCES users(id),
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
      prix REAL DEFAULT 0,
      paiement_requis INTEGER DEFAULT 0,
      rabais_json TEXT DEFAULT '{}',
      qr_token TEXT
    );

    CREATE TABLE IF NOT EXISTS activity_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      statut TEXT DEFAULT 'inscrit',
      date_inscription TEXT DEFAULT CURRENT_TIMESTAMP,
      paye INTEGER DEFAULT 0,
      montant_paye REAL DEFAULT 0,
      date_paiement TEXT,
      UNIQUE(activity_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS financial_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
      titre TEXT NOT NULL,
      budget_alloue REAL DEFAULT 0,
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
      statut TEXT DEFAULT 'actif'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      financial_line_id INTEGER REFERENCES financial_lines(id),
      type TEXT NOT NULL,
      montant REAL NOT NULL,
      description TEXT,
      methode TEXT DEFAULT 'cash',
      reference TEXT,
      invoice_id INTEGER REFERENCES invoices(id),
      cree_par INTEGER REFERENCES users(id),
      date_transaction TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titre TEXT NOT NULL,
      fournisseur TEXT,
      montant REAL,
      date_facture TEXT,
      photo_path TEXT,
      financial_line_id INTEGER REFERENCES financial_lines(id),
      cree_par INTEGER REFERENCES users(id),
      statut TEXT DEFAULT 'en_attente',
      date_upload TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS account_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT,
      numero_compte TEXT,
      nom_titulaire TEXT,
      solde REAL DEFAULT 0,
      date_maj TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sub_committees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      description TEXT,
      activity_id INTEGER REFERENCES activities(id),
      chef_id INTEGER REFERENCES users(id),
      statut TEXT DEFAULT 'actif',
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sub_committee_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      committee_id INTEGER REFERENCES sub_committees(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role_comite TEXT DEFAULT 'membre',
      UNIQUE(committee_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expediteur_id INTEGER REFERENCES users(id),
      sujet TEXT,
      contenu TEXT NOT NULL,
      type TEXT DEFAULT 'individuel',
      date_envoi TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      destinataire_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lu INTEGER DEFAULT 0,
      date_lecture TEXT
    );

    CREATE TABLE IF NOT EXISTS volunteer_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      activity_id INTEGER REFERENCES activities(id),
      heures REAL NOT NULL,
      description TEXT,
      date_service TEXT,
      statut TEXT DEFAULT 'en_attente',
      approuve_par INTEGER REFERENCES users(id),
      date_approbation TEXT
    );

    CREATE TABLE IF NOT EXISTS meeting_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auteur_id INTEGER REFERENCES users(id),
      titre TEXT,
      contenu TEXT,
      langue TEXT DEFAULT 'fr',
      contenu_corrige TEXT,
      date_reunion TEXT,
      activity_id INTEGER REFERENCES activities(id),
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
      date_modification TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recommendation_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      membre_id INTEGER REFERENCES users(id),
      demande_par INTEGER REFERENCES users(id),
      genere_par INTEGER REFERENCES users(id),
      contenu TEXT,
      date_demande TEXT DEFAULT CURRENT_TIMESTAMP,
      date_generation TEXT,
      signe_par INTEGER REFERENCES users(id),
      date_signature TEXT,
      statut TEXT DEFAULT 'demande'
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      titre TEXT,
      contenu TEXT,
      destinataire_id INTEGER REFERENCES users(id),
      source_id INTEGER,
      lu INTEGER DEFAULT 0,
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      description TEXT,
      responsable_id INTEGER REFERENCES users(id),
      statut TEXT DEFAULT 'en_cours',
      progression INTEGER DEFAULT 0,
      date_debut TEXT,
      date_fin TEXT,
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gallery_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titre TEXT,
      categorie TEXT DEFAULT 'general',
      photo_path TEXT NOT NULL,
      cree_par INTEGER REFERENCES users(id),
      date_upload TEXT DEFAULT CURRENT_TIMESTAMP,
      actif INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'group',
      activity_id INTEGER REFERENCES activities(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_room_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES chat_rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES chat_rooms(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      numero INTEGER NOT NULL,
      capacite_max INTEGER DEFAULT 10,
      membre_attribue INTEGER REFERENCES users(id),
      UNIQUE(activity_id, numero)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      table_id INTEGER REFERENCES activity_tables(id),
      user_id INTEGER REFERENCES users(id),
      acheteur_nom TEXT NOT NULL,
      acheteur_email TEXT DEFAULT '',
      acheteur_telephone TEXT DEFAULT '',
      vendu_par INTEGER REFERENCES users(id),
      qr_data TEXT,
      prix REAL DEFAULT 0,
      methode_paiement TEXT DEFAULT 'stripe',
      statut TEXT DEFAULT 'actif',
      date_vente TEXT DEFAULT CURRENT_TIMESTAMP,
      payment_intent_id TEXT,
      quantite INTEGER DEFAULT 1
    );
  `);

  // Seed initial admin accounts
  const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync('AHH2026!', 10);
    const insert = db.prepare(`
      INSERT INTO users (prenom, nom, email, telephone, password_hash, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run('Jean', 'Carme', 'presidente@ahhamilton.ca', '905-818-8269', hash, 'admin');
    insert.run('Jean', 'Raymond', 'vp@ahhamilton.ca', '905-818-8269', hash, 'admin');
    insert.run('Aviole', 'AHH', 'tresoriere@ahhamilton.ca', '', hash, 'tresoriere');
    insert.run('Pierre', 'Jeens', 'jeens@ahhamilton.ca', '', hash, 'secretaire');
    insert.run('Garry', 'AHH', 'garry@ahhamilton.ca', '', hash, 'delegue');
    insert.run('Dricoll', 'AHH', 'dricoll@ahhamilton.ca', '', hash, 'delegue');

    // Seed account info
    db.prepare(`INSERT INTO account_info (institution, numero_compte, nom_titulaire, solde)
      VALUES (?, ?, ?, ?)`)
      .run('Caisse populaire', '****-****-1234', 'AHH', 0);

    console.log('✅ Comptes initiaux créés (mot de passe: AHH2026!)');
  }

  // ── Comptes membres mamb1–mamb9 ──────────────────────────────────────
  const MAMB_PWD = 'mam123456';
  const hashMamb = bcrypt.hashSync(MAMB_PWD, 10);
  const mambData = [
    { i:1, prenom:'Marie',   nom:'Dupont',    plan:'gratuit'     },
    { i:2, prenom:'Jean',    nom:'Pierre',    plan:'gratuit'     },
    { i:3, prenom:'Rose',    nom:'Laurent',   plan:'gratuit'     },
    { i:4, prenom:'Paul',    nom:'Dumont',    plan:'gratuit'     },
    { i:5, prenom:'Sandra',  nom:'Éloi',      plan:'gratuit'     },
    { i:6, prenom:'Michel',  nom:'Joseph',    plan:'bienfaiteur' },
    { i:7, prenom:'Lesly',   nom:'Rénovation',plan:'bienfaiteur' },
    { i:8, prenom:'Claire',  nom:'Baptiste',  plan:'gratuit'     },
    { i:9, prenom:'Marc',    nom:'Henri',     plan:'gratuit'     },
  ];
  const insertM = db.prepare(`INSERT OR IGNORE INTO users (prenom, nom, email, password_hash, role, plan) VALUES (?,?,?,?,'member',?)`);
  mambData.forEach(m => insertM.run(m.prenom, m.nom, `mamb${m.i}@ahhamilton.ca`, hashMamb, m.plan));
  // Forcer le mot de passe ET actif=1 sur tous les comptes mamb (corrige anciens hashes et comptes désactivés)
  mambData.forEach(m => {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(`mamb${m.i}@ahhamilton.ca`);
    if (existing) {
      db.prepare("UPDATE users SET password_hash = ?, actif = 1 WHERE email = ?").run(hashMamb, `mamb${m.i}@ahhamilton.ca`);
      console.log(`  ↳ mamb${m.i} mis à jour`);
    } else {
      console.log(`  ↳ mamb${m.i} introuvable après INSERT, vérifier DB`);
    }
  });
  console.log('✅ Comptes mamb1–mamb9 synchronisés (mot de passe: mam123456)');

  // ── Salons de chat par défaut ──────────────────────────────────────────
  const existingRoom = db.prepare("SELECT id FROM chat_rooms WHERE type = 'general'").get();
  if (!existingRoom) {
    const addRoom = db.prepare(`INSERT INTO chat_rooms (name, type, created_by) VALUES (?, ?, 1)`);
    const generalId   = addRoom.run('💬 Général', 'general').lastInsertRowid;
    const committeeId = addRoom.run('🔒 Comité', 'committee').lastInsertRowid;

    // Ajouter tous les membres au salon Général
    const allUsers = db.prepare('SELECT id FROM users WHERE actif = 1').all();
    const addMember = db.prepare('INSERT OR IGNORE INTO chat_room_members (room_id, user_id) VALUES (?, ?)');
    allUsers.forEach(u => addMember.run(generalId, u.id));

    // Ajouter seulement le comité au salon Comité
    const committee = db.prepare("SELECT id FROM users WHERE role IN ('admin','tresoriere','secretaire','delegue') AND actif = 1").all();
    committee.forEach(u => addMember.run(committeeId, u.id));

    console.log('✅ Salons de chat créés (Général + Comité)');
  }

  // ── Témoignages par défaut ─────────────────────────────────────────────
  const existingTestimonial = db.prepare('SELECT id FROM testimonials LIMIT 1').get();
  if (!existingTestimonial) {
    const insT = db.prepare(`INSERT INTO testimonials (prenom, nom, description, texte, ordre) VALUES (?,?,?,?,?)`);
    insT.run('Marie-Claire', 'D.', 'Membre depuis 2022', "AHH m'a permis de trouver ma famille ici au Canada. Je me sens vraiment chez moi depuis que j'ai rejoint cette communauté.", 1);
    insT.run('Jean-Baptiste', 'M.', 'Père de famille', "Les activités culturelles nous permettent de garder nos racines vivantes. Nos enfants sont fiers de leur identité haïtienne.", 2);
    insT.run('Rose-Pétra', 'L.', 'Nouvelle arrivante', "Grâce à l'entraide de la communauté, mes premiers mois à Hamilton ont été tellement plus faciles. Merci à l'équipe d'AHH!", 3);
    insT.run('Paul', 'D.', 'Membre actif', "Les programmes d'assistance ont été une bouée de sauvetage pour notre famille à notre arrivée à Hamilton.", 4);
    insT.run('Sandra', 'E.', 'Bénévole', "Les événements d'AHH sont magnifiques. Ils renforcent notre identité collective et notre fierté haïtienne.", 5);
    insT.run('Michel', 'J.', 'Entrepreneur', "Le réseau AHH m'a ouvert des portes extraordinaires. Une communauté vraiment soudée et bienveillante.", 6);
    console.log('✅ Témoignages par défaut créés');
  }
}

init();

module.exports = db;
