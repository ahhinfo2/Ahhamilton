/**
 * Envoie l'email de bienvenue + lien création mot de passe
 * aux membres approuvés récemment.
 *
 * Usage:
 *   node scripts/send-welcome.js --test=leenesarah@gmail.com   → test sur un seul email
 *   node scripts/send-welcome.js --all                          → envoi à tous
 *   node scripts/send-welcome.js --all --days=3                → membres des 3 derniers jours
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const path   = require('path');

const db     = require(path.join(__dirname, '..', 'db', 'database'));
const mailer = require(path.join(__dirname, '..', 'mailer'));

const SITE_URL = process.env.SITE_URL || 'https://ahhamilton.ca';
const args     = process.argv.slice(2);
const testEmail = (args.find(a => a.startsWith('--test=')) || '').split('=')[1] || null;
const sendAll   = args.includes('--all');
const daysArg   = parseInt((args.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 2;

const DELAY_MS       = 8000;  // 8s entre chaque email (Hostinger rate limit)
const RETRY_WAIT_MS  = 35000; // 35s d'attente si rate limit détecté
const MAX_RETRIES    = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Retourne le token existant si valide, sinon en crée un nouveau. */
function getOrCreateToken(userId) {
  const existing = db.prepare(
    "SELECT token FROM password_reset_tokens WHERE user_id=? AND used=0 AND expires_at > datetime('now') LIMIT 1"
  ).get(userId);
  if (existing) return `${SITE_URL}/dashboard/reset-password.html?token=${existing.token}`;

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600000).toISOString();
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(userId);
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)').run(userId, token, expires);
  return `${SITE_URL}/dashboard/reset-password.html?token=${token}`;
}

async function sendWithRetry(user, resetLink, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mailer.sendBienvenue(user, resetLink);
      return;
    } catch (e) {
      const isRateLimit = e.message && e.message.includes('451');
      if (isRateLimit && attempt < retries) {
        console.warn(`  ⏳ Rate limit — attente ${RETRY_WAIT_MS / 1000}s avant réessai (${attempt}/${retries})...`);
        await sleep(RETRY_WAIT_MS);
      } else {
        throw e;
      }
    }
  }
}

async function main() {
  const since = new Date();
  since.setDate(since.getDate() - daysArg);
  const sinceStr = since.toISOString().split('T')[0];

  const approved = db.prepare(`
    SELECT p.prenom, p.nom, p.email, p.date_traitement,
           u.id AS user_id
    FROM pending_registrations p
    LEFT JOIN users u ON LOWER(u.email) = LOWER(p.email)
    WHERE p.statut = 'approuve'
      AND DATE(p.date_traitement) >= ?
    ORDER BY p.date_traitement ASC
  `).all(sinceStr);

  if (!approved.length) {
    console.log(`Aucun membre approuvé depuis ${sinceStr}.`);
    console.log('Essayez avec --days=7 pour élargir la fenêtre.');
    return;
  }

  console.log(`\n${approved.length} membre(s) approuvé(s) depuis ${sinceStr}:`);
  approved.forEach(m => {
    const status = m.user_id ? `user_id=${m.user_id}` : '⚠️  compte introuvable';
    console.log(`  ${m.prenom} ${m.nom} <${m.email}> — ${status}`);
  });

  if (!testEmail && !sendAll) {
    console.log('\nUsage:');
    console.log(`  node scripts/send-welcome.js --test=leenesarah@gmail.com`);
    console.log(`  node scripts/send-welcome.js --all`);
    return;
  }

  if (testEmail) {
    const first = approved.find(m => m.user_id);
    if (!first) {
      console.error('\n❌ Aucun compte utilisateur trouvé.');
      return;
    }
    const resetLink = getOrCreateToken(first.user_id);
    const testUser  = { prenom: first.prenom, nom: first.nom, email: testEmail };
    console.log(`\n[TEST] Envoi à ${testEmail} (données de ${first.prenom} ${first.nom})...`);
    await sendWithRetry(testUser, resetLink);
    console.log(`✅ Email test envoyé à ${testEmail}`);
    console.log(`   Lien : ${resetLink}`);
    console.log('\nSi OK → node scripts/send-welcome.js --all');
    return;
  }

  // --all : envoi à chaque membre avec délai
  console.log(`\nEnvoi avec délai de ${DELAY_MS / 1000}s entre chaque email...\n`);
  let sent = 0, skipped = 0, errors = 0;

  for (let i = 0; i < approved.length; i++) {
    const m = approved[i];
    if (!m.user_id) {
      console.warn(`⚠️  ${m.email} — compte introuvable, ignoré`);
      skipped++;
      continue;
    }
    try {
      const resetLink = getOrCreateToken(m.user_id);
      await sendWithRetry({ prenom: m.prenom, nom: m.nom, email: m.email }, resetLink);
      console.log(`✅ [${i + 1}/${approved.length}] ${m.prenom} ${m.nom} <${m.email}>`);
      sent++;
      if (i < approved.length - 1) await sleep(DELAY_MS); // pas de délai après le dernier
    } catch (e) {
      console.error(`❌ ${m.email}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nTerminé : ${sent} envoyé(s), ${skipped} ignoré(s), ${errors} erreur(s).`);
  if (errors > 0) {
    console.log('Pour relancer uniquement les erreurs, attendez ~10 min et relancez --all.');
    console.log('Les tokens existants seront réutilisés (liens inchangés).');
  }
}

main().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
