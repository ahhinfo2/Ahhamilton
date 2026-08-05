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
try { db.exec('ALTER TABLE activities ADD COLUMN featured INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN image_path TEXT'); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  value TEXT
)`); } catch {}
try { db.exec('ALTER TABLE tax_receipts ADD COLUMN print_token TEXT'); } catch {}
// Push notifications subscriptions
try { db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
// Votes/élections
try { db.exec(`CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'election',
  statut TEXT DEFAULT 'brouillon',
  date_debut TEXT,
  date_fin TEXT,
  options_json TEXT NOT NULL,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS vote_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vote_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  option_index INTEGER NOT NULL,
  date_vote TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vote_id, user_id)
)`); } catch {}
// Parrainage
try { db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER REFERENCES users(id)'); } catch {}
// Préférences de notification membres
try { db.exec('ALTER TABLE users ADD COLUMN notif_activites INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN notif_paiements INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN notif_messages INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN notif_forum INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN notif_emplois INTEGER DEFAULT 1'); } catch {}
// Carte de membre numérique
try { db.exec('ALTER TABLE users ADD COLUMN carte_photo_approuvee INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN carte_notif_renouv INTEGER DEFAULT 0'); } catch {}
// Marqueur permanent : vrai dès la 1ère approbation, jamais remis à zéro ensuite
try { db.exec('ALTER TABLE users ADD COLUMN carte_photo_deja_approuvee INTEGER DEFAULT 0'); } catch {}
// Titre du comité affiché sur la carte de membre (ex. Présidente, Vice-président, Conseiller)
try { db.exec('ALTER TABLE users ADD COLUMN titre_comite TEXT'); } catch {}
// Photo complète (non recadrée) conservée pour pouvoir réajuster le cadrage plus tard
try { db.exec('ALTER TABLE users ADD COLUMN photo_original_url TEXT'); } catch {}
// Date réelle d'arrivée comme membre actif à AHH (distincte de date_inscription, qui ancre le
// cycle de renouvellement de la carte de 2 ans) — permet au comité de corriger l'affichage
// "Membre depuis" pour les membres présents avant la création du site.
try { db.exec('ALTER TABLE users ADD COLUMN membre_depuis TEXT'); } catch {}
// Pointage bénévolat par scan QR : arrivée/départ, statut 'en_cours' pendant la présence
try { db.exec('ALTER TABLE volunteer_hours ADD COLUMN checkin_at TEXT'); } catch {}
try { db.exec('ALTER TABLE volunteer_hours ADD COLUMN checkout_at TEXT'); } catch {}
// Collaboration notes : dernier éditeur + qui édite en ce moment
try { db.exec('ALTER TABLE meeting_notes ADD COLUMN last_editor_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE meeting_notes ADD COLUMN editing_by INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE meeting_notes ADD COLUMN editing_since TEXT'); } catch {}

// ── Espace Jeunes (15-30 ans) ─────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS young_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'stage',
  titre TEXT NOT NULL,
  organisation TEXT,
  description TEXT,
  lieu TEXT,
  date_limite TEXT,
  lien_externe TEXT,
  contact TEXT,
  cree_par INTEGER REFERENCES users(id),
  actif INTEGER DEFAULT 1,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec('ALTER TABLE young_jobs ADD COLUMN source TEXT DEFAULT \'manual\''); } catch {}
try { db.exec('ALTER TABLE young_jobs ADD COLUMN source_id TEXT'); } catch {}
try { db.exec('ALTER TABLE young_jobs ADD COLUMN statut TEXT DEFAULT \'approuve\''); } catch {}
try { db.exec('ALTER TABLE young_jobs ADD COLUMN salaire TEXT'); } catch {}
try { db.exec('ALTER TABLE young_jobs ADD COLUMN categorie TEXT'); } catch {}
try { db.exec('ALTER TABLE young_jobs ADD COLUMN company_logo TEXT'); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS young_trainings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  formateur TEXT,
  date_debut TEXT,
  date_fin TEXT,
  lieu TEXT,
  places_max INTEGER DEFAULT 20,
  prix REAL DEFAULT 0,
  gratuit INTEGER DEFAULT 1,
  lien_inscription TEXT,
  cree_par INTEGER REFERENCES users(id),
  actif INTEGER DEFAULT 1,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS young_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  description TEXT,
  cree_par INTEGER REFERENCES users(id),
  actif INTEGER DEFAULT 1,
  date_fin TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES young_polls(id) ON DELETE CASCADE,
  texte TEXT NOT NULL,
  ordre INTEGER DEFAULT 0
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES young_polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date_vote TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(poll_id, user_id)
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS success_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  titre TEXT NOT NULL,
  contenu TEXT NOT NULL,
  photo_url TEXT,
  approuve INTEGER DEFAULT 0,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// Statistiques contrôlables par le comité
try { db.exec(`CREATE TABLE IF NOT EXISTS stats_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  membres_global INTEGER,
  benevoles_global INTEGER,
  annees_service INTEGER DEFAULT 18,
  show_membres INTEGER DEFAULT 1,
  show_benevoles INTEGER DEFAULT 1
)`); } catch {}
// Insérer la ligne par défaut si absente
try { db.exec(`INSERT OR IGNORE INTO stats_config (id, annees_service) VALUES (1, 18)`); } catch {}
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
// Code-barres unique Code128 pour chaque ticket
try { db.exec('ALTER TABLE tickets ADD COLUMN barcode_data TEXT'); } catch {}
// Tables réservées par membre comité pour vente en personne
try { db.exec(`CREATE TABLE IF NOT EXISTS comite_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  table_debut INTEGER NOT NULL,
  table_fin INTEGER NOT NULL,
  UNIQUE(activity_id, user_id)
)`); } catch {}
// Projets avec budget et ligne financière
try { db.exec('ALTER TABLE projects ADD COLUMN budget_prevu REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE projects ADD COLUMN notes TEXT'); } catch {}
// Email organisationnel par membre du comité
try { db.exec('ALTER TABLE users ADD COLUMN email_org TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN smtp_pass_org TEXT'); } catch {}
// Vérification email + invalidation sessions
try { db.exec('ALTER TABLE pending_registrations ADD COLUMN email_verified INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE pending_registrations ADD COLUMN email_token TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT'); } catch {}
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

// Carte des commerces tenus par des membres — soumission par un membre, publication après
// approbation du comité (contrairement aux annonces/talents, auto-publiés par défaut) :
// une adresse publique sur une carte mérite une vérification avant mise en ligne.
try { db.exec(`CREATE TABLE IF NOT EXISTS business_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  nom TEXT NOT NULL,
  categorie TEXT NOT NULL DEFAULT 'autre',
  description TEXT,
  adresse TEXT NOT NULL,
  telephone TEXT,
  email TEXT,
  site_web TEXT,
  lat REAL,
  lng REAL,
  photo_url TEXT,
  statut TEXT DEFAULT 'en_attente',
  refus_raison TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_approbation TEXT
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
try { db.exec(`CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  prenom TEXT,
  date_inscription TEXT DEFAULT CURRENT_TIMESTAMP,
  actif INTEGER DEFAULT 1
)`); } catch {}
try { db.exec(`ALTER TABLE gallery_photos ADD COLUMN featured INTEGER DEFAULT 0`); } catch {}

// Paiements d'avance (nb de mois couverts)
try { db.exec("ALTER TABLE payments ADD COLUMN nb_mois INTEGER DEFAULT 1"); } catch {}
// Reçus fiscaux — archivage
try { db.exec("ALTER TABLE tax_receipts ADD COLUMN archived INTEGER DEFAULT 0"); } catch {}
// Suivi des connexions par membre
try { db.exec("ALTER TABLE users ADD COLUMN nb_connexions INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN derniere_connexion TEXT"); } catch {}

// Cotisations membres (dues générées le 15 de chaque mois)
try { db.exec(`CREATE TABLE IF NOT EXISTS cotisations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  periode TEXT NOT NULL,
  montant_attendu REAL NOT NULL,
  plan TEXT NOT NULL,
  periodicite TEXT DEFAULT 'mensuel',
  statut TEXT DEFAULT 'en_attente',
  date_echeance TEXT NOT NULL,
  payment_id INTEGER REFERENCES payments(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, periode)
)`); } catch {}

// Paiement annuel
try { db.exec("ALTER TABLE payments ADD COLUMN periodicite TEXT DEFAULT 'mensuel'"); } catch {}
try { db.exec("ALTER TABLE payments ADD COLUMN periode_fin TEXT"); } catch {}

// ── Tâches assignées ─────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  statut TEXT DEFAULT 'a_faire',
  priorite TEXT DEFAULT 'moyenne',
  assigne_a INTEGER REFERENCES users(id),
  cree_par INTEGER REFERENCES users(id),
  echeance TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_completion TEXT,
  categorie TEXT DEFAULT 'autre'
)`); } catch {}

// ── Ordre du jour (Agendas) ──────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS agendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  date_reunion TEXT,
  statut TEXT DEFAULT 'brouillon',
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS agenda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agenda_id INTEGER REFERENCES agendas(id) ON DELETE CASCADE,
  texte TEXT NOT NULL,
  ordre INTEGER DEFAULT 0,
  duree_minutes INTEGER DEFAULT 5,
  responsable_id INTEGER REFERENCES users(id),
  note TEXT
)`); } catch {}

// ── Registre des décisions ───────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  date_decision TEXT,
  decidee_par TEXT,
  responsable_id INTEGER REFERENCES users(id),
  echeance TEXT,
  statut TEXT DEFAULT 'en_cours',
  agenda_id INTEGER REFERENCES agendas(id),
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Politiques et règlements ─────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  categorie TEXT DEFAULT 'reglement',
  contenu TEXT,
  version TEXT DEFAULT '1.0',
  statut TEXT DEFAULT 'brouillon',
  approuve_par INTEGER REFERENCES users(id),
  date_approbation TEXT,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_modification TEXT
)`); } catch {}

// ── Journal d'audit ──────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  cible TEXT,
  cible_id INTEGER,
  details TEXT,
  ip TEXT,
  date_action TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Modèles de courriels ─────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  sujet TEXT NOT NULL,
  corps TEXT NOT NULL,
  categorie TEXT DEFAULT 'general',
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_modification TEXT
)`); } catch {}
// Seed default templates
try { db.exec(`INSERT OR IGNORE INTO email_templates (nom, sujet, corps, categorie) VALUES
  ('Bienvenue nouveau membre', 'Bienvenue à l''Association Haïtienne de Hamilton !', 'Bonjour {prenom},\n\nNous avons le plaisir de vous accueillir au sein de l''Association Haïtienne de Hamilton (AHH).\n\nVotre adhésion a été approuvée. Vous pouvez dès maintenant accéder à votre espace membre.\n\nCordialement,\nLe comité exécutif de l''AHH', 'bienvenue'),
  ('Rappel cotisation', 'Rappel — Cotisation AHH', 'Bonjour {prenom},\n\nNous vous rappelons que votre cotisation pour le mois de {mois} est en attente.\n\nMerci de procéder au paiement dans les meilleurs délais.\n\nCordialement,\nLe comité exécutif de l''AHH', 'rappel'),
  ('Convocation réunion', 'Convocation — Réunion AHH', 'Bonjour {prenom},\n\nVous êtes convoqué(e) à la prochaine réunion de l''AHH.\n\nDate : {date}\nLieu : {lieu}\n\nVotre présence est importante.\n\nCordialement,\nLe comité exécutif de l''AHH', 'notification')
`); } catch {}

// ── Calendrier des réunions ──────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS meeting_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'ordinaire',
  date_heure TEXT NOT NULL,
  duree_minutes INTEGER DEFAULT 60,
  lieu TEXT,
  lien_virtuel TEXT,
  agenda_id INTEGER REFERENCES agendas(id),
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  rappel_envoye INTEGER DEFAULT 0
)`); } catch {}

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

    CREATE TABLE IF NOT EXISTS volunteer_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      demande_par INTEGER REFERENCES users(id),
      statut TEXT DEFAULT 'en_attente',
      signataire_id INTEGER REFERENCES users(id),
      signature_data TEXT,
      date_signature TEXT,
      date_envoi TEXT,
      envoye_par INTEGER REFERENCES users(id),
      print_token TEXT,
      total_heures REAL,
      heures_json TEXT,
      date_creation TEXT DEFAULT CURRENT_TIMESTAMP
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
    insert.run('Pierre', 'Jeens', 'secretaire@ahhamilton.ca', '', hash, 'secretaire');
    insert.run('Garry', 'AHH', 'delegue1@ahhamilton.ca', '', hash, 'delegue');
    insert.run('Dricoll', 'AHH', 'delegue2@ahhamilton.ca', '', hash, 'delegue');

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

  // ── Comptes comité (adresses génériques réassignables) ────────────────
  // Si un délégué/secrétaire quitte un jour, son successeur reprend la même
  // adresse (delegueX@, secretaire@) sans avoir à recréer un compte.
  const COMMITTEE_PWD = 'AHH2026!';
  const hashCommittee = bcrypt.hashSync(COMMITTEE_PWD, 10);
  const committeeAccounts = [
    { oldEmails: ['jean-carme@ahhamilton.ca'], email: 'presidente@ahhamilton.ca', prenom: 'Jean',    nom: 'Carme',   role: 'admin',      titre_comite: 'Présidente'     },
    { oldEmails: [],                           email: 'vp@ahhamilton.ca',        prenom: 'Jean',    nom: 'Raymond', role: 'admin',      titre_comite: 'Vice-Président' },
    { oldEmails: ['aviole@ahhamilton.ca'],     email: 'tresoriere@ahhamilton.ca', prenom: 'Aviole',  nom: 'AHH',     role: 'tresoriere', titre_comite: 'Trésorière'     },
    { oldEmails: ['jeens@ahhamilton.ca'],      email: 'secretaire@ahhamilton.ca', prenom: 'Pierre',  nom: 'Jeens',   role: 'secretaire', titre_comite: 'Secrétaire'     },
    { oldEmails: ['garry@ahhamilton.ca'],      email: 'delegue1@ahhamilton.ca',   prenom: 'Garry',   nom: 'AHH',     role: 'delegue',    titre_comite: 'Délégué'        },
    { oldEmails: ['driscoll@ahhamilton.ca'],   email: 'delegue2@ahhamilton.ca',   prenom: 'Dricoll', nom: 'AHH',     role: 'delegue',    titre_comite: 'Délégué'        },
  ];
  committeeAccounts.forEach(c => {
    let user = null;
    for (const e of [c.email, ...c.oldEmails]) {
      user = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
      if (user) break;
    }
    if (user) {
      // Ne jamais écraser un titre déjà personnalisé manuellement par le comité
      db.prepare("UPDATE users SET email = ?, password_hash = ?, actif = 1, titre_comite = COALESCE(NULLIF(titre_comite,''), ?) WHERE id = ?")
        .run(c.email, hashCommittee, c.titre_comite, user.id);
    } else {
      db.prepare('INSERT INTO users (prenom, nom, email, password_hash, role, titre_comite) VALUES (?,?,?,?,?,?)')
        .run(c.prenom, c.nom, c.email, hashCommittee, c.role, c.titre_comite);
    }
  });
  console.log('✅ Comptes comité synchronisés (mot de passe: AHH2026!)');

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

// ── Badges membres ────────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  nom TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '🏅',
  critere TEXT
)`); } catch {}
try { db.exec(`INSERT OR IGNORE INTO badges (code,nom,description,icon,critere) VALUES
  ('membre_1an','Membre 1 an','Membre actif depuis 1 an','🥉','1 an membership'),
  ('membre_3ans','Membre 3 ans','Membre actif depuis 3 ans','🥈','3 ans membership'),
  ('membre_5ans','Membre 5 ans','Membre fidèle depuis 5 ans','🥇','5 ans membership'),
  ('benevole_25h','Bénévole 25h','25 heures de bénévolat approuvées','🤝','25h bénévolat'),
  ('benevole_100h','Super bénévole','100 heures de bénévolat approuvées','🌟','100h bénévolat'),
  ('bienfaiteur','Bienfaiteur','Plan bienfaiteur actif','💛','plan bienfaiteur'),
  ('partenaire','Partenaire','Plan partenaire actif','⭐','plan partenaire'),
  ('parrain','Parrain','A parrainé au moins 1 membre','🫂','parrainage'),
  ('talent','Talent reconnu','Talent publié et approuvé','🎨','talent publié'),
  ('fondateur','Membre fondateur','Inscrit avant 2022','🏛️','inscription avant 2022')
`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS user_badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  date_attribution TEXT DEFAULT CURRENT_TIMESTAMP,
  attribue_par INTEGER REFERENCES users(id),
  UNIQUE(user_id, badge_id)
)`); } catch {}

// ── Logs d'activité admin ──────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  cible_id INTEGER,
  cible_type TEXT,
  ip TEXT,
  date_action TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Signatures électroniques de documents ─────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS document_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signature_data TEXT NOT NULL,
  date_signature TEXT DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  UNIQUE(document_id, user_id)
)`); } catch {}

// ── Contributions collaboratives aux notes de réunion ────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS note_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER REFERENCES meeting_notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  contenu TEXT NOT NULL DEFAULT '',
  derniere_frappe TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(note_id, user_id)
)`); } catch {}

// ── Signatures électroniques des notes de réunion ────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS note_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER REFERENCES meeting_notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signature_data TEXT NOT NULL,
  date_signature TEXT DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  UNIQUE(note_id, user_id)
)`); } catch {}
try { db.exec("ALTER TABLE meeting_notes ADD COLUMN verrouille INTEGER DEFAULT 0"); } catch {}

// ── Rencontres comité (présences + signatures) ────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS committee_meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_heure TEXT NOT NULL,
  lieu TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  cree_par INTEGER REFERENCES users(id),
  verrouille INTEGER DEFAULT 0,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS committee_meeting_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES committee_meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  statut TEXT NOT NULL DEFAULT 'absent',
  date_modification TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(meeting_id, user_id)
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS committee_meeting_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES committee_meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signature_data TEXT NOT NULL,
  date_signature TEXT DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  UNIQUE(meeting_id, user_id)
)`); } catch {}

// Commentaire libre + hash (anti-doublon) sur les reçus/factures
try { db.exec("ALTER TABLE invoices ADD COLUMN commentaire TEXT"); } catch {}
try { db.exec("ALTER TABLE invoices ADD COLUMN photo_hash TEXT"); } catch {}

// Fermeture d'une ligne financière (projet/activité) — verrouillée après 2 signatures, comme les rencontres comité
try { db.exec(`CREATE TABLE IF NOT EXISTS financial_line_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  financial_line_id INTEGER NOT NULL REFERENCES financial_lines(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signature_data TEXT NOT NULL,
  date_signature TEXT DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  UNIQUE(financial_line_id, user_id)
)`); } catch {}

// ── Token iCal personnel par membre ───────────────────────────────────────
try { db.exec("ALTER TABLE users ADD COLUMN ical_token TEXT"); } catch {}

// Documents officiels de l'association
try { db.exec(`CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  categorie TEXT DEFAULT 'autre',
  fichier_path TEXT NOT NULL,
  fichier_nom TEXT NOT NULL,
  taille INTEGER DEFAULT 0,
  mime_type TEXT,
  upload_par INTEGER REFERENCES users(id),
  date_upload TEXT DEFAULT (datetime('now'))
)`); } catch {}

// ── Ambassadeur du mois ───────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS ambassador (
  id INTEGER PRIMARY KEY CHECK(id=1),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  nom TEXT,
  prenom TEXT,
  role_description TEXT DEFAULT '',
  citation TEXT DEFAULT '',
  photo_url TEXT,
  mois TEXT DEFAULT (strftime('%Y-%m', 'now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`); } catch {}
// S'assurer qu'il y a toujours une ligne
try { db.exec("INSERT OR IGNORE INTO ambassador(id) VALUES(1)"); } catch {}

try { db.exec("ALTER TABLE users ADD COLUMN birthday_notif_year INTEGER DEFAULT 0"); } catch {}

// ── Sponsors / Commanditaires ─────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  site_web TEXT DEFAULT '',
  photo_url TEXT,
  categorie TEXT DEFAULT 'or',
  actif INTEGER DEFAULT 1,
  ordre INTEGER DEFAULT 0,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Équipe dirigeante (page publique index.html + equipe.html) ─────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS team_bureau (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  titre TEXT NOT NULL,
  citation TEXT DEFAULT '',
  photo_url TEXT,
  couleur1 TEXT DEFAULT '#1b5e20',
  couleur2 TEXT DEFAULT '#43a047',
  actif INTEGER DEFAULT 1,
  ordre INTEGER DEFAULT 0,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
// Seed unique avec les 6 membres déjà affichés en dur sur le site, pour ne rien perdre à la migration
try {
  const nb = db.prepare('SELECT COUNT(*) AS c FROM team_bureau').get().c;
  if (nb === 0) {
    const seed = db.prepare(`INSERT INTO team_bureau (nom, titre, citation, photo_url, couleur1, couleur2, ordre) VALUES (?,?,?,?,?,?,?)`);
    seed.run('Jean-Carme Dorcent', 'Présidente', "Ma vision est de construire une communauté haïtienne forte et fière à Hamilton, où chaque famille se sent chez elle et peut s'épanouir pleinement.", '/Public/Jean Carme.jpg', '#f9a825', '#fdd835', 1);
    seed.run('Jean Raymond Antoine', 'Vice-Président', "Ensemble, nous avons la force de surmonter tous les défis. Je m'engage à soutenir chaque initiative qui fait avancer notre communauté.", '/Public/Jean Raymond.jpg', '#1b5e20', '#43a047', 2);
    seed.run('Aviole Vincent', 'Trésorière', "La transparence et la rigueur financière garantissent que chaque dollar donné sert vraiment notre mission communautaire.", '/Public/Aviole.jpg', '#6a1b9a', '#ab47bc', 3);
    seed.run('Pierre Jeens Cazeau', 'Secrétaire', "Chaque voix mérite d'être entendue. Je veille à ce que nos décisions reflètent les aspirations de toute notre communauté.", '/Public/Pierre Jeens.jpg', '#0277bd', '#29b6f6', 4);
    seed.run('Garry Talma', 'Conseiller', "Je suis le lien entre nos membres et notre comité. Votre bonheur et votre intégration sont au cœur de mon engagement quotidien.", '/Public/Garry.jpg', '#d84315', '#ff7043', 5);
    seed.run('Driscoll Médé', 'Conseiller', "Représenter notre communauté est un honneur. Je m'assure que chaque membre soit informé, inclus et valorisé dans toutes nos activités.", '/Public/Driscoll.jpg', '#00695c', '#26a69a', 6);
  }
} catch {}

// ── Délégation de scan (billets/cartes) ─────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS scan_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delegue_par INTEGER NOT NULL REFERENCES users(id),
  type TEXT DEFAULT 'billets',
  actif INTEGER DEFAULT 1,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_expiration TEXT
)`); } catch {}

// ── Journal des scans ───────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS scan_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id),
  scanner_id INTEGER NOT NULL REFERENCES users(id),
  code_scanne TEXT,
  resultat TEXT NOT NULL,
  details TEXT,
  ticket_id INTEGER,
  date_scan TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Formulaires (Google Forms-like) ────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  image_path TEXT,
  share_token TEXT NOT NULL UNIQUE,
  activity_id INTEGER REFERENCES activities(id),
  statut TEXT DEFAULT 'actif',
  allow_anonymous INTEGER DEFAULT 1,
  message_fin TEXT DEFAULT 'Merci pour votre réponse !',
  redirect_adhesion INTEGER DEFAULT 1,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_fermeture TEXT
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS form_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'text',
  label TEXT NOT NULL,
  description TEXT,
  obligatoire INTEGER DEFAULT 0,
  options_json TEXT,
  ordre INTEGER DEFAULT 0
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS form_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  nom TEXT,
  email TEXT,
  telephone TEXT,
  date_reponse TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS form_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES form_responses(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES form_fields(id) ON DELETE CASCADE,
  valeur TEXT
)`); } catch {}

// ── Likes / Réactions ────────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reaction TEXT DEFAULT 'like',
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, target_type, target_id)
)`); } catch {}

// ── Commentaires ─────────────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  contenu TEXT NOT NULL,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Récurrence activités ─────────────────────────────────────────────────────
try { db.exec("ALTER TABLE activities ADD COLUMN recurrence TEXT"); } catch {}
try { db.exec("ALTER TABLE activities ADD COLUMN recurrence_end TEXT"); } catch {}
try { db.exec("ALTER TABLE activities ADD COLUMN parent_activity_id INTEGER"); } catch {}

// ── Liste d'attente ─────────────────────────────────────────────────────────
try { db.exec("ALTER TABLE activity_registrations ADD COLUMN waitlist INTEGER DEFAULT 0"); } catch {}

// ── Covoiturage ─────────────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS rideshares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'offer',
  depart TEXT,
  places INTEGER DEFAULT 1,
  heure_depart TEXT,
  note TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS rideshare_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rideshare_id INTEGER NOT NULL REFERENCES rideshares(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  statut TEXT DEFAULT 'en_attente',
  date_demande TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Boutique en ligne ──────────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS shop_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  description TEXT,
  prix REAL NOT NULL,
  image_path TEXT,
  categorie TEXT DEFAULT 'general',
  stock INTEGER DEFAULT 0,
  actif INTEGER DEFAULT 1,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS shop_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  acheteur_nom TEXT,
  acheteur_email TEXT,
  acheteur_telephone TEXT,
  total REAL NOT NULL,
  statut TEXT DEFAULT 'en_attente',
  methode TEXT DEFAULT 'interac',
  reference TEXT,
  date_commande TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS shop_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES shop_products(id),
  quantite INTEGER DEFAULT 1,
  prix_unitaire REAL NOT NULL
)`); } catch {}

// ── Streaming vidéo sur activités ──────────────────────────────────────────
try { db.exec("ALTER TABLE activities ADD COLUMN stream_url TEXT"); } catch {}
try { db.exec("ALTER TABLE activities ADD COLUMN stream_actif INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE activities ADD COLUMN rabais_jeune INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE activity_registrations ADD COLUMN rabais_applique INTEGER DEFAULT 0"); } catch {}

// ── Feedback post-activité ────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS activity_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id),
  user_id INTEGER REFERENCES users(id),
  note INTEGER CHECK(note BETWEEN 1 AND 5),
  commentaire TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Transfert de billets ──────────────────────────────────────────────────
try { db.exec('ALTER TABLE tickets ADD COLUMN transferred_to INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN transferred_at TEXT'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN original_owner_id INTEGER'); } catch {}

// ── Suivi d'impression (distinguer plusieurs lots générés pour une même activité) ──
try { db.exec('ALTER TABLE tickets ADD COLUMN imprime_le TEXT'); } catch {}

// ── Photos d'activité soumises par les membres (avec approbation) ────────
try { db.exec(`CREATE TABLE IF NOT EXISTS member_activity_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id),
  user_id INTEGER REFERENCES users(id),
  photo_path TEXT NOT NULL,
  caption TEXT,
  statut TEXT DEFAULT 'en_attente',
  approuve_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// ── Check-in par géolocalisation ─────────────────────────────────────────
try { db.exec('ALTER TABLE activities ADD COLUMN latitude REAL'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN longitude REAL'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN geo_radius INTEGER DEFAULT 200'); } catch {}

// ── Paiement en versements (split payment) ──────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS payment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  ticket_id INTEGER REFERENCES tickets(id),
  total_amount REAL NOT NULL,
  nb_versements INTEGER NOT NULL,
  montant_versement REAL NOT NULL,
  versements_payes INTEGER DEFAULT 0,
  statut TEXT DEFAULT 'actif',
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS payment_plan_versements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER REFERENCES payment_plans(id),
  numero INTEGER NOT NULL,
  montant REAL NOT NULL,
  statut TEXT DEFAULT 'en_attente',
  date_paiement TEXT,
  stripe_payment_id TEXT
)`); } catch {}

// ── Sous-tâches & commentaires (Enhanced Kanban) ────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS task_subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  titre TEXT NOT NULL,
  termine INTEGER DEFAULT 0,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  contenu TEXT NOT NULL,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN fichier_path TEXT'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN fichier_nom TEXT'); } catch {}

// ── Rôles personnalisés ─────────────────────────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS custom_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  permissions_json TEXT DEFAULT '{}',
  couleur TEXT DEFAULT '#555',
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN custom_role_id INTEGER REFERENCES custom_roles(id)'); } catch {}

// ── Stripe abonnements récurrents ──────────────────────────────────────────
try { db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN subscription_status TEXT'); } catch {}

// ── Places assises (seating) pour activités ───────────────────────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS activity_seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
  section TEXT DEFAULT 'General',
  rangee TEXT,
  numero TEXT NOT NULL,
  prix REAL,
  statut TEXT DEFAULT 'disponible',
  ticket_id INTEGER REFERENCES tickets(id),
  user_id INTEGER REFERENCES users(id),
  date_reservation TEXT
)`); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN seating_enabled INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN seating_config TEXT'); } catch {}

// ── Inscription bénévole liée à l'activité (une pierre deux coups) ──────
try { db.exec('ALTER TABLE activities ADD COLUMN benevoles_max INTEGER'); } catch {}
try { db.exec('ALTER TABLE activities ADD COLUMN prix_benevole REAL'); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS fierte_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  initiales TEXT,
  categorie TEXT NOT NULL DEFAULT 'autre',
  titre_badge TEXT,
  texte TEXT NOT NULL,
  date_realisation TEXT,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT (datetime('now'))
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS alertes_urgentes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  titre TEXT NOT NULL,
  description TEXT NOT NULL,
  categorie TEXT DEFAULT 'autre',
  statut TEXT DEFAULT 'actif',
  contact TEXT,
  date_creation TEXT DEFAULT (datetime('now')),
  date_resolution TEXT
)`); } catch {}

// Catégorisation des transactions/factures (loyer, nourriture, transport...) pour les rapports
try { db.exec("ALTER TABLE invoices ADD COLUMN categorie TEXT DEFAULT 'autre'"); } catch {}
try { db.exec("ALTER TABLE transactions ADD COLUMN categorie TEXT DEFAULT 'autre'"); } catch {}

// Registre des fournisseurs — alimenté automatiquement depuis le champ "fournisseur" des factures
try { db.exec(`CREATE TABLE IF NOT EXISTS fournisseurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telephone TEXT,
  email TEXT,
  notes TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// Budget annuel global (revenus/dépenses prévus pour l'année, comparés au réel)
try { db.exec(`CREATE TABLE IF NOT EXISTS annual_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annee INTEGER NOT NULL UNIQUE,
  budget_revenus REAL DEFAULT 0,
  budget_depenses REAL DEFAULT 0,
  notes TEXT,
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_maj TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// Registre de correspondance officielle (lettres/courriers entrants et sortants du secrétariat)
try { db.exec(`CREATE TABLE IF NOT EXISTS correspondance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'sortant',
  date_correspondance TEXT NOT NULL,
  destinataire TEXT,
  expediteur TEXT,
  objet TEXT NOT NULL,
  resume TEXT,
  methode TEXT DEFAULT 'courriel',
  fichier_path TEXT,
  fichier_nom TEXT,
  statut TEXT DEFAULT 'classe',
  cree_par INTEGER REFERENCES users(id),
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// Personnes à charge (enfants/famille) rattachées à un membre
try { db.exec(`CREATE TABLE IF NOT EXISTS dependents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prenom TEXT NOT NULL,
  nom TEXT NOT NULL,
  lien TEXT NOT NULL DEFAULT 'enfant',
  date_naissance TEXT,
  notes TEXT,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// Délégation de présidence (intérim) — un admin peut désigner un membre du comité
// comme président(e) par intérim pendant une absence, sur le même principe que
// les délégations de scan.
try { db.exec(`CREATE TABLE IF NOT EXISTS presidence_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delegue_par INTEGER NOT NULL REFERENCES users(id),
  motif TEXT,
  actif INTEGER DEFAULT 1,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_expiration TEXT
)`); } catch {}

// Lettres de bénévolat — total et détail des heures figés au moment de la signature
// (sans ça, le lien envoyé au membre afficherait un total qui bouge si de nouvelles heures
// sont approuvées après coup, alors que la signature est censée certifier un total précis).
try { db.exec("ALTER TABLE volunteer_letters ADD COLUMN total_heures REAL"); } catch {}
try { db.exec("ALTER TABLE volunteer_letters ADD COLUMN heures_json TEXT"); } catch {}

// Lettres de recommandation — même circuit de signature (une seule, président ou VP) + envoi
// que les lettres de bénévolat. signe_par/date_signature existaient déjà mais n'étaient jamais
// utilisés (aucune route ne les remplissait) ; on ajoute ce qu'il manque pour l'envoi.
try { db.exec("ALTER TABLE recommendation_letters ADD COLUMN signature_data TEXT"); } catch {}
try { db.exec("ALTER TABLE recommendation_letters ADD COLUMN date_envoi TEXT"); } catch {}
try { db.exec("ALTER TABLE recommendation_letters ADD COLUMN envoye_par INTEGER REFERENCES users(id)"); } catch {}
try { db.exec("ALTER TABLE recommendation_letters ADD COLUMN print_token TEXT"); } catch {}

// Ordre du jour — devient un document officiel (lettre AHH, listes seulement) avec verrouillage 2 signatures
try { db.exec("ALTER TABLE agendas ADD COLUMN contenu TEXT"); } catch {}
try { db.exec("ALTER TABLE agendas ADD COLUMN verrouille INTEGER DEFAULT 0"); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS agenda_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agenda_id INTEGER NOT NULL REFERENCES agendas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signature_data TEXT NOT NULL,
  date_signature TEXT DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  UNIQUE(agenda_id, user_id)
)`); } catch {}

// Lier un ordre du jour (non verrouillé) à une rencontre du comité
try { db.exec('ALTER TABLE committee_meetings ADD COLUMN agenda_id INTEGER REFERENCES agendas(id)'); } catch {}

// ── Élections de comité (mini-comité électoral, visibilité restreinte, vote public) ──
try { db.exec(`CREATE TABLE IF NOT EXISTS committee_elections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT,
  statut TEXT NOT NULL DEFAULT 'proposition',
  cree_par INTEGER REFERENCES users(id),
  public_token TEXT UNIQUE,
  date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
  date_ouverture TEXT,
  date_fermeture TEXT
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS committee_election_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES committee_elections(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  nom TEXT NOT NULL,
  bio TEXT DEFAULT '',
  photo_path TEXT,
  ordre INTEGER DEFAULT 0
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS committee_election_committee (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES committee_elections(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(election_id, user_id)
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS committee_election_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES committee_elections(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date_approbation TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(election_id, user_id)
)`); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS committee_election_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES committee_elections(id) ON DELETE CASCADE,
  candidate_id INTEGER NOT NULL REFERENCES committee_election_candidates(id),
  telephone TEXT NOT NULL,
  nom_votant TEXT,
  date_vote TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(election_id, telephone)
)`); } catch {}

init();

module.exports = db;
