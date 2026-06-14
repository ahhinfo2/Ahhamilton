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

function generateToken(userId) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600000).toISOString();
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expires);
  return `${SITE_URL}/dashboard/reset-password.html?token=${token}`;
}

async function main() {
  const since = new Date();
  since.setDate(since.getDate() - daysArg);
  const sinceStr = since.toISOString().split('T')[0]; // 'YYYY-MM-DD'

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
      console.error('\n❌ Aucun compte utilisateur trouvé pour les membres approuvés.');
      console.error('Vérifiez que les comptes ont bien été créés lors de l\'approbation.');
      return;
    }
    const resetLink = generateToken(first.user_id);
    const testUser  = { prenom: first.prenom, nom: first.nom, email: testEmail };
    console.log(`\n[TEST] Envoi à ${testEmail} avec les données de ${first.prenom} ${first.nom}...`);
    await mailer.sendBienvenue(testUser, resetLink);
    console.log(`✅ Email test envoyé à ${testEmail}`);
    console.log(`   Lien reset : ${resetLink}`);
    console.log('\nSi le test est satisfaisant, lancez:');
    console.log('  node scripts/send-welcome.js --all');
    return;
  }

  // --all : envoyer à chaque membre
  let sent = 0, skipped = 0, errors = 0;
  for (const m of approved) {
    if (!m.user_id) {
      console.warn(`⚠️  ${m.email} — compte introuvable, ignoré`);
      skipped++;
      continue;
    }
    try {
      const resetLink = generateToken(m.user_id);
      await mailer.sendBienvenue({ prenom: m.prenom, nom: m.nom, email: m.email }, resetLink);
      console.log(`✅ ${m.prenom} ${m.nom} <${m.email}>`);
      sent++;
      await new Promise(r => setTimeout(r, 600)); // éviter le rate limiting SMTP
    } catch (e) {
      console.error(`❌ ${m.email}: ${e.message}`);
      errors++;
    }
  }
  console.log(`\nTerminé : ${sent} envoyé(s), ${skipped} ignoré(s), ${errors} erreur(s).`);
}

main().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
