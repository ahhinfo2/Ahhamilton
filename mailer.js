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
async function sendMail({ to, subject, html, text, from, replyTo }) {
  const t = getTransporter();
  if (!t) {
    console.log(`📧 [DEV] Email non envoyé (SMTP non configuré)\n  À: ${to}\n  Sujet: ${subject}`);
    return false;
  }
  await t.sendMail({ from: from || FROM, to, subject, html, text, replyTo });
  console.log(`✉️  Email envoyé → ${to} | ${subject}`);
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

async function sendNouvelleAdhesion(staffEmail, candidat) {
  await sendMail({
    to: staffEmail,
    subject: `📋 Nouvelle demande d'adhésion — ${candidat.prenom} ${candidat.nom}`,
    html: wrap('Nouvelle demande d\'adhésion', `
      <p>Une nouvelle demande d'adhésion a été soumise et attend votre approbation.</p>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;margin:16px 0">
        <tr><td style="padding:6px 0;color:#888">Nom</td><td><strong>${candidat.prenom} ${candidat.nom}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888">Courriel</td><td>${candidat.email}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Téléphone</td><td>${candidat.telephone || '–'}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Plan souhaité</td><td>${candidat.plan || 'gratuit'}</td></tr>
        ${candidat.message ? `<tr><td style="padding:6px 0;color:#888">Message</td><td>${candidat.message}</td></tr>` : ''}
      </table>
      <a href="${siteUrl}/dashboard/app.html" class="btn">Approuver ou refuser</a>
    `)
  });
}

async function sendHeuresBenevolat(user, heures, description, date) {
  await sendMail({
    to: user.email,
    subject: `✅ ${heures}h de bénévolat ajoutées à votre compte — AHH`,
    html: wrap('Heures de bénévolat confirmées', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p><strong>${heures} heure${heures > 1 ? 's' : ''}</strong> de bénévolat ont été ajoutées à votre compte.</p>
      ${description ? `<p><strong>Description :</strong> ${description}</p>` : ''}
      ${date ? `<p><strong>Date :</strong> ${new Date(date).toLocaleDateString('fr-CA', { dateStyle:'long' })}</p>` : ''}
      <p>Consultez le total de vos heures dans votre profil :</p>
      <a href="${siteUrl}/dashboard/app.html" class="btn">Mon profil</a>
    `)
  });
}

// ── Billets en ligne ─────────────────────────────────────────────────────────

async function sendBilletInterac(email, prenom, activite, billets, orderRef, interacEmail, montantTotal) {
  const dateAct = activite.date_debut ? new Date(activite.date_debut).toLocaleDateString('fr-CA', { dateStyle: 'long' }) : '';
  await sendMail({
    to: email,
    subject: `🎟 Réservation confirmée — ${activite.titre} — AHH`,
    html: wrap('Votre réservation de billets', `
      <p>Bonjour <strong>${prenom}</strong>,</p>
      <p>Votre réservation pour <strong>${activite.titre}</strong> est bien reçue !</p>
      ${dateAct ? `<p>📅 <strong>${dateAct}</strong>${activite.lieu ? ' — 📍 ' + activite.lieu : ''}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:.88rem">
        <thead><tr style="background:#e8f5e9"><th style="padding:8px;text-align:left">Billet</th><th style="padding:8px;text-align:right">Prix</th></tr></thead>
        <tbody>
          ${billets.map(b => `<tr style="border-bottom:1px solid #e0ede0"><td style="padding:7px 8px">${b.nom || 'Billet'}</td><td style="padding:7px 8px;text-align:right">$${(b.prix || 0).toFixed(2)}</td></tr>`).join('')}
          <tr style="background:#e8f5e9;font-weight:700"><td style="padding:8px">Total</td><td style="padding:8px;text-align:right">$${montantTotal.toFixed(2)}</td></tr>
        </tbody>
      </table>
      <div style="background:#fff3e0;border-left:4px solid #f9a825;border-radius:8px;padding:16px;margin:16px 0">
        <strong style="color:#e65100">💳 Comment payer par virement Interac :</strong>
        <ol style="margin:10px 0 0 16px;color:#3a3a3a;font-size:.88rem;line-height:1.8">
          <li>Ouvrez votre application bancaire</li>
          <li>Envoyez <strong>$${montantTotal.toFixed(2)} CAD</strong> à : <strong>${interacEmail}</strong></li>
          <li>Inscrivez comme message/référence : <strong>${orderRef}</strong></li>
          <li>Une fois votre paiement reçu, vos codes QR vous seront envoyés par courriel</li>
        </ol>
      </div>
      <p style="font-size:.82rem;color:#888">Référence de commande : <strong>${orderRef}</strong> — conservez ce courriel.</p>
    `)
  });
}

async function sendBilletQR(email, prenom, activite, billet, qrBase64) {
  const dateAct = activite.date_debut ? new Date(activite.date_debut).toLocaleDateString('fr-CA', { dateStyle: 'long' }) : '';
  await sendMail({
    to: email,
    subject: `🎫 Votre billet — ${activite.titre} — AHH`,
    html: wrap('Votre billet est prêt !', `
      <p>Bonjour <strong>${prenom}</strong>,</p>
      <p>Votre paiement a été confirmé. Voici votre billet pour <strong>${activite.titre}</strong>.</p>
      ${dateAct ? `<p>📅 <strong>${dateAct}</strong>${activite.lieu ? ' — 📍 ' + activite.lieu : ''}</p>` : ''}
      ${billet.nom ? `<p>Type : <strong>${billet.nom}</strong></p>` : ''}
      <div style="text-align:center;margin:24px 0">
        <img src="data:image/png;base64,${qrBase64}" alt="Code QR" style="width:200px;height:200px;border:6px solid #1b5e20;border-radius:12px"/>
        <p style="font-size:.78rem;color:#888;margin-top:8px">Présentez ce code QR à l'entrée</p>
      </div>
      <div style="background:#e8f5e9;border-radius:8px;padding:12px;text-align:center;font-size:.82rem;color:#1b5e20">
        ⚠️ Ce billet est <strong>personnel et non transférable</strong>. Chaque billet ne peut être scanné qu'une seule fois.
      </div>
    `)
  });
}

async function sendNouvelleCommandeBillet(activite, acheteurNom, email, montantTotal, billets, orderRef) {
  const adminEmails = process.env.NOTIFY_EMAILS ? process.env.NOTIFY_EMAILS.split(',').map(e => e.trim()) : [];
  const to = process.env.SMTP_USER;
  if (!to) return;
  await sendMail({
    to: [to, ...adminEmails].join(','),
    subject: `🎟 Nouvelle commande de billets — ${activite.titre}`,
    html: wrap('Nouvelle commande de billets', `
      <p><strong>Acheteur :</strong> ${acheteurNom} (${email})</p>
      <p><strong>Activité :</strong> ${activite.titre}</p>
      <p><strong>Billets :</strong> ${billets.length} billet(s) — Total : <strong>$${montantTotal.toFixed(2)}</strong></p>
      <p><strong>Référence :</strong> ${orderRef}</p>
      <p>Confirmez le paiement dans le tableau de bord pour envoyer les codes QR.</p>
      <a href="${siteUrl}/dashboard/app.html" class="btn">Tableau de bord</a>
    `)
  });
}

// ── Courriel externe depuis le comité ────────────────────────────────────
async function sendExternalEmail({ to, subject, bodyHtml, senderName, senderEmail }) {
  const from    = `"${senderName} — AHH" <${SMTP_USER}>`;
  const replyTo = senderEmail ? `"${senderName}" <${senderEmail}>` : FROM;
  const html = wrap(subject,
    `<p>Bonjour,</p>
     ${bodyHtml}
     <hr class="divider"/>
     <p style="font-size:.8rem;color:#888">
       Ce message vous a été envoyé par <strong>${senderName}</strong>
       au nom de l'<strong>Association Haïtienne de Hamilton</strong>.<br/>
       Pour répondre, écrivez à : <a href="mailto:${senderEmail || 'contact@ahhamilton.ca'}">${senderEmail || 'contact@ahhamilton.ca'}</a>
     </p>`
  );
  return sendMail({ to, subject, html, from, replyTo });
}

module.exports = {
  sendMail, sendBienvenue, sendInscriptionRefusee, sendResetPassword,
  sendContact, sendRappelPaiement, sendPaiementApprouve,
  sendRecuFiscal, sendInscriptionActivite, sendNouvelleAdhesion, sendHeuresBenevolat,
  sendBilletInterac, sendBilletQR, sendNouvelleCommandeBillet, sendExternalEmail
};
