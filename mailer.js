// ── Module email centralisé — AHH ────────────────────────────────────────
require('dotenv').config();
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SITE_URL } = process.env;

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT) || 587,
    secure: false,       // STARTTLS sur 587
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
  return _transporter;
}

const FROM = `"AHH – Association Haïtienne de Hamilton" <${SMTP_USER}>`;
const siteUrl = SITE_URL || 'http://localhost:3001';

// ── Enveloppe HTML commune ────────────────────────────────────────────────
function wrap(titre, corps) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f7f4;margin:0;padding:0}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(27,94,32,.1)}
  .hdr{background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:28px 32px;text-align:center}
  .hdr img{width:56px;height:56px;border-radius:10px;object-fit:cover;border:2px solid rgba(255,255,255,.3)}
  .hdr h1{color:#fff;font-size:1.15rem;font-weight:700;margin:10px 0 0}
  .body{padding:32px}
  .body p{color:#3a3a3a;font-size:.9rem;line-height:1.7;margin:0 0 14px}
  .body strong{color:#1b5e20}
  .btn{display:inline-block;background:linear-gradient(135deg,#2e7d32,#43a047);color:#fff!important;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;margin:10px 0}
  .divider{border:none;border-top:1px solid #e8f5e9;margin:20px 0}
  .footer{background:#f0f7f0;padding:18px 32px;text-align:center;font-size:.75rem;color:#7a9a7a;border-top:1px solid #e0ede0}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <img src="${siteUrl}/Public/logo.jpg" alt="AHH"/>
    <h1>Association Haïtienne de Hamilton</h1>
  </div>
  <div class="body">
    <h2 style="color:#1b5e20;font-size:1.1rem;margin:0 0 18px">${titre}</h2>
    ${corps}
  </div>
  <div class="footer">
    231 Fernwood Crescent, Hamilton, ON L8T 3L7 &nbsp;|&nbsp;
    <a href="mailto:contact@ahhamilton.ca" style="color:#2e7d32">contact@ahhamilton.ca</a><br/>
    © 2026 Association Haïtienne de Hamilton
  </div>
</div>
</body></html>`;
}

// ── Fonction d'envoi principale ───────────────────────────────────────────
async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    console.log(`📧 [DEV] Email non envoyé (SMTP non configuré)\n  À: ${to}\n  Sujet: ${subject}`);
    return false;
  }
  try {
    await t.sendMail({ from: FROM, to, subject, html, text });
    console.log(`✉️  Email envoyé → ${to} | ${subject}`);
    return true;
  } catch (err) {
    console.error(`❌ Erreur email → ${to}:`, err.message);
    return false;
  }
}

// ── Templates ─────────────────────────────────────────────────────────────

async function sendBienvenue(user) {
  await sendMail({
    to: user.email,
    subject: `Bienvenue dans la communauté AHH, ${user.prenom} !`,
    html: wrap('Bienvenue !', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre compte a été approuvé. Vous faites maintenant partie de l'<strong>Association Haïtienne de Hamilton</strong> !</p>
      <p>Connectez-vous à votre espace membre :</p>
      <a href="${siteUrl}/dashboard/login.html" class="btn">Accéder à mon espace</a>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">Identifiant : ${user.email}</p>
    `)
  });
}

async function sendInscriptionRefusee(user, raison) {
  await sendMail({
    to: user.email,
    subject: 'Votre demande d\'adhésion — AHH',
    html: wrap('Demande d\'adhésion', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Nous avons bien reçu votre demande d'adhésion. Malheureusement, nous ne pouvons pas y donner suite pour le moment.</p>
      ${raison ? `<p>Motif : ${raison}</p>` : ''}
      <p>N'hésitez pas à nous contacter pour plus d'informations.</p>
      <a href="mailto:contact@ahhamilton.ca" class="btn">Nous contacter</a>
    `)
  });
}

async function sendResetPassword(user, resetLink) {
  await sendMail({
    to: user.email,
    subject: 'Réinitialisation de votre mot de passe — AHH',
    html: wrap('Réinitialisation du mot de passe', `
      <p>Bonjour <strong>${user.prenom}</strong>,</p>
      <p>Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous (valide <strong>1 heure</strong>) :</p>
      <a href="${resetLink}" class="btn">Réinitialiser mon mot de passe</a>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">Si vous n'avez pas fait cette demande, ignorez cet email.</p>
    `)
  });
}

async function sendContact({ nom, email, sujet, message }) {
  await sendMail({
    to: process.env.CONTACT_EMAIL || SMTP_USER,
    subject: `[Contact AHH] ${sujet}`,
    html: wrap('Nouveau message de contact', `
      <p><strong>De :</strong> ${nom} (${email})</p>
      <p><strong>Sujet :</strong> ${sujet}</p>
      <hr class="divider"/>
      <p>${message.replace(/\n/g, '<br/>')}</p>
    `)
  });
  // Confirmation à l'expéditeur
  await sendMail({
    to: email,
    subject: 'Votre message a été reçu — AHH',
    html: wrap('Message reçu', `
      <p>Bonjour <strong>${nom}</strong>,</p>
      <p>Nous avons bien reçu votre message concernant <strong>"${sujet}"</strong>.</p>
      <p>Notre équipe vous répondra dans les 48 heures.</p>
    `)
  });
}

async function sendRappelPaiement(user, montant, mois) {
  await sendMail({
    to: user.email,
    subject: `Rappel de paiement — ${mois} — AHH`,
    html: wrap('Rappel de cotisation', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Nous n'avons pas encore reçu votre cotisation de <strong>$${montant}</strong> pour le mois de <strong>${mois}</strong>.</p>
      <p>Connectez-vous à votre espace membre pour déclarer votre paiement :</p>
      <a href="${siteUrl}/dashboard/app.html" class="btn">Accéder à mon espace</a>
    `)
  });
}

async function sendPaiementApprouve(user, montant, mois) {
  await sendMail({
    to: user.email,
    subject: `Paiement approuvé — ${mois} — AHH`,
    html: wrap('Paiement confirmé', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre paiement de <strong>$${montant}</strong> pour <strong>${mois}</strong> a été approuvé et comptabilisé.</p>
      <p>Merci pour votre contribution à la communauté !</p>
      <a href="${siteUrl}/dashboard/app.html" class="btn">Mon espace membre</a>
    `)
  });
}

async function sendRecuFiscal(user, annee, montant, recuId) {
  await sendMail({
    to: user.email,
    subject: `Votre reçu fiscal ${annee} — AHH`,
    html: wrap(`Reçu fiscal ${annee}`, `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre reçu fiscal pour l'année <strong>${annee}</strong> est disponible.</p>
      <p><strong>Total des contributions :</strong> $${Number(montant).toFixed(2)} CAD</p>
      <p>Vous pouvez l'imprimer depuis votre espace membre :</p>
      <a href="${siteUrl}/api/receipts/${recuId}/print" class="btn">Voir mon reçu fiscal</a>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">Conservez ce document pour votre déclaration de revenus.</p>
    `)
  });
}

async function sendInscriptionActivite(user, activite) {
  await sendMail({
    to: user.email,
    subject: `Inscription confirmée — ${activite.titre}`,
    html: wrap('Inscription confirmée', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre inscription à <strong>${activite.titre}</strong> est confirmée !</p>
      ${activite.date_debut ? `<p><strong>Date :</strong> ${new Date(activite.date_debut).toLocaleDateString('fr-CA', {dateStyle:'long'})}</p>` : ''}
      ${activite.lieu ? `<p><strong>Lieu :</strong> ${activite.lieu}</p>` : ''}
      <a href="${siteUrl}/dashboard/app.html" class="btn">Mon espace membre</a>
    `)
  });
}

module.exports = {
  sendMail, sendBienvenue, sendInscriptionRefusee, sendResetPassword,
  sendContact, sendRappelPaiement, sendPaiementApprouve,
  sendRecuFiscal, sendInscriptionActivite
};
