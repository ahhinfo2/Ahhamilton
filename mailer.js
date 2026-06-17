// ── Module email centralisé — AHH ────────────────────────────────────────
require('dotenv').config();
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ORG_SMTP_PASS, IMAP_HOST, IMAP_PORT, SITE_URL } = process.env;

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

const FROM = `"Association Haïtienne de Hamilton" <${SMTP_USER}>`;

// ── Passerelles SMS canadiennes ───────────────────────────────────────────
const SMS_GATEWAYS = {
  rogers:       'pcs.rogers.com',
  bell:         'txt.bell.ca',
  telus:        'msg.telus.com',
  fido:         'fido.ca',
  freedom:      'txt.freedommobile.ca',
  koodo:        'msg.koodomobile.com',
  virgin:       'vmobile.ca',
  chatr:        'pcs.rogers.com',
  public_mobile:'msg.telus.com',
  videotron:    'vmobile.ca',
  eastlink:     'txt.eastlink.ca',
};

async function sendSMS(user, message) {
  if (!user || !user.telephone || !user.operateur || !user.sms_notifs) return;
  const gateway = SMS_GATEWAYS[user.operateur];
  if (!gateway) return;
  const phone = user.telephone.replace(/\D/g, '').slice(-10);
  if (phone.length < 10) return;
  const text = ('AHH: ' + message).substring(0, 155);
  try {
    await sendMail({ to: `${phone}@${gateway}`, subject: '', text, html: text });
    console.log(`📱 SMS → ${phone}@${gateway}`);
  } catch(e) {
    console.error('[SMS] Erreur:', e.message);
  }
}
const siteUrl = SITE_URL || 'https://ahhamilton.ca';

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
    <img src="${siteUrl}/Public/logo1.png" alt="AHH"/>
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
async function sendMail({ to, subject, html, text, from, replyTo, attachments }) {
  const t = getTransporter();
  if (!t) {
    const msg = `SMTP non configuré — email non envoyé à ${to} | ${subject}`;
    console.error(`📧 ${msg}`);
    throw new Error(msg);
  }
  // Version texte brut automatique si absente (améliore la délivrabilité et réduit le spam)
  const plainText = text || (html ? html.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim() : '');
  await t.sendMail({ from: from || FROM, to, subject, html, text: plainText, replyTo, attachments });
  console.log(`✉️  Email envoyé → ${to} | ${subject}`);
}

// ── Templates ─────────────────────────────────────────────────────────────

async function sendBienvenue(user, resetLink) {
  const lien = resetLink || `${siteUrl}/dashboard/forgot-password.html`;
  const loginUrl = `${siteUrl}/dashboard/login.html`;
  await sendMail({
    to: user.email,
    subject: `Bienvenue dans la famille AHH, ${user.prenom} !`,
    html: wrap('Bienvenue dans la famille AHH !', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Je suis <strong>Jean-Carme Dorcent</strong>, présidente de l'<strong>Association Haïtienne de Hamilton (AHH)</strong>.</p>
      <p>C'est avec grand plaisir que je vous souhaite la bienvenue dans notre famille ! Depuis <strong>18 ans</strong>, l'AHH œuvre pour le rayonnement et l'épanouissement de la communauté haïtienne de Hamilton, et vous en faites maintenant partie.</p>
      <p>Votre adhésion a été <strong>approuvée</strong>. Cliquez ci-dessous pour accéder à votre espace membre :</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${loginUrl}" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:1rem;font-family:Arial,sans-serif">
          Accéder à mon espace membre
        </a>
      </div>
      <p style="font-size:.84rem;color:#555">Si c'est votre première connexion ou si vous avez oublié votre mot de passe, utilisez ce lien pour le créer ou le réinitialiser :</p>
      <p style="font-size:.82rem;text-align:center">
        <a href="${lien}" style="color:#2e7d32;word-break:break-all">${lien}</a>
      </p>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">
        Identifiant de connexion : <strong>${user.email}</strong><br/>
        Le lien de réinitialisation est valide pendant <strong>7 jours</strong>.
      </p>
      <p style="font-size:.84rem;color:#555;margin-top:16px">Au plaisir de vous retrouver lors de nos prochaines activités !</p>
      <p style="font-size:.84rem;color:#555"><strong>Jean-Carme Dorcent</strong><br/>Présidente, AHH Hamilton</p>
    `)
  });
}

async function sendInscriptionRefusee(user, raison) {
  await sendMail({
    to: user.email,
    subject: 'Votre demande d\'adhésion | AHH',
    html: wrap('Demande d\'adhésion', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Nous avons bien reçu votre demande d'adhésion. Malheureusement, nous ne pouvons pas y donner suite pour le moment.</p>
      ${raison ? `<p>Motif : ${raison}</p>` : ''}
      <p>N'hésitez pas à nous contacter pour plus d'informations.</p>
      <div style="text-align:center;margin:20px 0"><a href="mailto:contact@ahhamilton.ca" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Nous contacter</a></div>
    `)
  });
}

async function sendResetPassword(user, resetLink) {
  await sendMail({
    to: user.email,
    subject: 'Réinitialisation de votre mot de passe | AHH',
    html: wrap('Réinitialisation du mot de passe', `
      <p>Bonjour <strong>${user.prenom}</strong>,</p>
      <p>Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous (valide <strong>1 heure</strong>) :</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${resetLink}" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:1rem;font-family:Arial,sans-serif">
          🔑 Réinitialiser mon mot de passe
        </a>
      </div>
      <p style="font-size:.82rem;color:#888;text-align:center">Ou copiez ce lien : <a href="${resetLink}" style="color:#2e7d32;word-break:break-all">${resetLink}</a></p>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">Si vous n'avez pas fait cette demande, ignorez cet email.</p>
    `)
  });
}

async function sendContact({ nom, email, sujet, message, toList = null }) {
  const defaultDest = process.env.CONTACT_EMAIL || SMTP_USER;
  const targets = toList && toList.length ? toList : (defaultDest ? [defaultDest] : []);
  const unique = [...new Set(targets.filter(Boolean))];
  const html = wrap('Nouveau message de contact', `
      <p><strong>De :</strong> ${nom} (${email})</p>
      <p><strong>Sujet :</strong> ${sujet}</p>
      <hr class="divider"/>
      <p>${message.replace(/\n/g, '<br/>')}</p>
    `);
  if (unique.length) {
    await sendMail({ to: unique.join(', '), subject: `[Contact AHH] ${sujet}`, html });
  }
  // Confirmation à l'expéditeur (une seule fois)
  await sendMail({
    to: email,
    subject: 'Votre message a été reçu | AHH',
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
    subject: `Rappel de paiement : ${mois} | AHH`,
    html: wrap('Rappel de cotisation', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Nous n'avons pas encore reçu votre cotisation de <strong>$${montant}</strong> pour le mois de <strong>${mois}</strong>.</p>
      <p>Connectez-vous à votre espace membre pour déclarer votre paiement :</p>
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Accéder à mon espace</a>
    `)
  });
}

async function sendPaiementApprouve(user, montant, mois) {
  await sendMail({
    to: user.email,
    subject: `Paiement approuvé : ${mois} | AHH`,
    html: wrap('Paiement confirmé', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre paiement de <strong>$${montant}</strong> pour <strong>${mois}</strong> a été approuvé et comptabilisé.</p>
      <p>Merci pour votre contribution à la communauté !</p>
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Mon espace membre</a>
    `)
  });
}

async function sendRecuFiscal(user, annee, montant, recuId, printToken) {
  const printUrl = printToken
    ? `${siteUrl}/api/receipts/${recuId}/print?token=${printToken}`
    : `${siteUrl}/api/receipts/${recuId}/print`;
  await sendMail({
    to: user.email,
    subject: `Votre reçu fiscal ${annee} | AHH`,
    html: wrap(`Reçu fiscal ${annee}`, `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre reçu fiscal pour l'année <strong>${annee}</strong> est disponible.</p>
      <p><strong>Total des contributions :</strong> $${Number(montant).toFixed(2)} CAD</p>
      <p>Cliquez sur le bouton ci-dessous pour voir et imprimer votre reçu :</p>
      <a href="${printUrl}" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Voir mon reçu fiscal</a>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">Conservez ce document pour votre déclaration de revenus.</p>
    `)
  });
}

async function sendInscriptionActivite(user, activite) {
  await sendMail({
    to: user.email,
    subject: `Inscription confirmée : ${activite.titre}`,
    html: wrap('Inscription confirmée', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Votre inscription à <strong>${activite.titre}</strong> est confirmée !</p>
      ${activite.date_debut ? `<p><strong>Date :</strong> ${new Date(activite.date_debut).toLocaleDateString('fr-CA', {dateStyle:'long'})}</p>` : ''}
      ${activite.lieu ? `<p><strong>Lieu :</strong> ${activite.lieu}</p>` : ''}
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Mon espace membre</a>
    `)
  });
}

async function sendInvitation(email, inviteLink) {
  await sendMail({
    to: email,
    subject: "Invitation à rejoindre l'AHH Hamilton",
    html: wrap("Invitation à l'AHH Hamilton", `
      <p>Bonjour,</p>
      <p>Le comité de l'<strong>Association Haïtienne de Hamilton</strong> vous invite à créer votre profil de membre.</p>
      <p>Cliquez sur le bouton ci-dessous pour accéder au formulaire d'adhésion et choisir votre mot de passe :</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${inviteLink}" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:.95rem;font-family:Arial,sans-serif">Créer mon profil membre</a>
      </div>
      <p style="font-size:.82rem;color:#888">Ou copiez ce lien dans votre navigateur :<br/>
        <a href="${inviteLink}" style="color:#2e7d32;word-break:break-all">${inviteLink}</a>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
      <p style="font-size:.78rem;color:#aaa">Une fois le formulaire complété, votre demande sera examinée par le comité qui vous contactera sous peu.</p>
    `)
  });
}

async function sendNouvelleAdhesion(staffEmails, candidat) {
  const to = Array.isArray(staffEmails) ? staffEmails.filter(Boolean).join(', ') : staffEmails;
  if (!to) return;
  await sendMail({
    to,
    subject: `📋 Nouvelle demande d'adhésion : ${candidat.prenom} ${candidat.nom}`,
    html: wrap('Nouvelle demande d\'adhésion', `
      <p>Une nouvelle demande d'adhésion a été soumise et attend votre approbation.</p>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;margin:16px 0">
        <tr><td style="padding:6px 0;color:#888">Nom</td><td><strong>${candidat.prenom} ${candidat.nom}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888">Courriel</td><td>${candidat.email}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Téléphone</td><td>${candidat.telephone || '–'}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Plan souhaité</td><td>${candidat.plan || 'gratuit'}</td></tr>
        ${candidat.message ? `<tr><td style="padding:6px 0;color:#888">Message</td><td>${candidat.message}</td></tr>` : ''}
      </table>
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Approuver ou refuser</a>
    `)
  });
}

async function sendHeuresBenevolat(user, heures, description, date) {
  await sendMail({
    to: user.email,
    subject: `✅ ${heures}h de bénévolat ajoutées à votre compte | AHH`,
    html: wrap('Heures de bénévolat confirmées', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p><strong>${heures} heure${heures > 1 ? 's' : ''}</strong> de bénévolat ont été ajoutées à votre compte.</p>
      ${description ? `<p><strong>Description :</strong> ${description}</p>` : ''}
      ${date ? `<p><strong>Date :</strong> ${new Date(date).toLocaleDateString('fr-CA', { dateStyle:'long' })}</p>` : ''}
      <p>Consultez le total de vos heures dans votre profil :</p>
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Mon profil</a>
    `)
  });
}

// ── Billets en ligne ─────────────────────────────────────────────────────────

async function sendBilletInterac(email, prenom, activite, billets, orderRef, interacEmail, montantTotal) {
  const dateAct = activite.date_debut ? new Date(activite.date_debut).toLocaleDateString('fr-CA', { dateStyle: 'long' }) : '';
  await sendMail({
    to: email,
    subject: `🎟 Réservation confirmée : ${activite.titre} | AHH`,
    html: wrap('Votre réservation de billets', `
      <p>Bonjour <strong>${prenom}</strong>,</p>
      <p>Votre réservation pour <strong>${activite.titre}</strong> est bien reçue !</p>
      ${dateAct ? `<p>📅 <strong>${dateAct}</strong>${activite.lieu ? ' · 📍 ' + activite.lieu : ''}</p>` : ''}
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
      <p style="font-size:.82rem;color:#888">Référence de commande : <strong>${orderRef}</strong>. Conservez ce courriel.</p>
    `)
  });
}

async function sendBilletQR(email, prenom, activite, billet, qrBase64, qrPublicUrl) {
  const dateAct = activite.date_debut ? new Date(activite.date_debut).toLocaleDateString('fr-CA', { dateStyle: 'long' }) : '';
  const qrImgHtml = qrPublicUrl
    ? `<img src="${qrPublicUrl}" width="220" height="220" alt="Code QR" style="display:block;border:5px solid #1b5e20;border-radius:12px;margin:0 auto"/>`
    : `<img src="cid:qrcode@ahh" width="220" height="220" alt="Code QR" style="display:block;border:5px solid #1b5e20;border-radius:12px;margin:0 auto"/>`;

  const ticketHtml = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;border:2px solid #1b5e20;border-radius:16px;overflow:hidden">
      <!-- En-tête vert -->
      <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:20px;text-align:center">
        <img src="${siteUrl}/Public/logo1.png" width="60" height="60" alt="AHH" style="border-radius:10px;margin-bottom:8px;display:block;margin:0 auto 8px"/>
        <div style="color:#fff;font-size:1.1rem;font-weight:700">Association Haïtienne de Hamilton</div>
        <div style="color:rgba(255,255,255,.8);font-size:.8rem;margin-top:2px">Billet d'entrée</div>
      </div>
      <!-- Infos activité -->
      <div style="background:#fff;padding:20px;text-align:center;border-bottom:2px dashed #c8e6c9">
        <div style="font-size:1.4rem;font-weight:700;color:#1b5e20;margin-bottom:8px">${activite.titre}</div>
        ${dateAct ? `<div style="color:#444;font-size:.9rem;margin-bottom:4px">📅 ${dateAct}</div>` : ''}
        ${activite.lieu ? `<div style="color:#444;font-size:.9rem">📍 ${activite.lieu}</div>` : ''}
        ${billet.nom ? `<div style="display:inline-block;background:#e8f5e9;color:#1b5e20;font-weight:600;padding:4px 14px;border-radius:20px;font-size:.82rem;margin-top:8px">${billet.nom}</div>` : ''}
      </div>
      <!-- QR Code -->
      <div style="background:#fff;padding:24px;text-align:center">
        <div style="font-size:.8rem;color:#888;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Présentez ce code à l'entrée</div>
        ${qrImgHtml}
        <div style="font-size:.72rem;color:#aaa;margin-top:10px">Bonjour ${prenom}, billet personnel non transférable</div>
      </div>
      <!-- Pied -->
      <div style="background:#f4f8f4;padding:12px;text-align:center;font-size:.75rem;color:#888">
        ⚠️ Ce billet ne peut être scanné qu'<strong>une seule fois</strong>. Conservez-le précieusement.
      </div>
    </div>`;

  await sendMail({
    to: email,
    subject: `🎫 Votre billet : ${activite.titre}`,
    html: ticketHtml,
    attachments: qrPublicUrl ? [] : [{
      filename: 'billet-qr.png',
      content: Buffer.from(qrBase64, 'base64'),
      cid: 'qrcode@ahh',
      contentType: 'image/png'
    }]
  });
}

async function sendNouvelleCommandeBillet(activite, acheteurNom, email, montantTotal, billets, orderRef) {
  const adminEmails = process.env.NOTIFY_EMAILS ? process.env.NOTIFY_EMAILS.split(',').map(e => e.trim()) : [];
  const to = process.env.SMTP_USER;
  if (!to) return;
  await sendMail({
    to: [to, ...adminEmails].join(','),
    subject: `🎟 Nouvelle commande de billets : ${activite.titre}`,
    html: wrap('Nouvelle commande de billets', `
      <p><strong>Acheteur :</strong> ${acheteurNom} (${email})</p>
      <p><strong>Activité :</strong> ${activite.titre}</p>
      <p><strong>Billets :</strong> ${billets.length} billet(s), total : <strong>$${montantTotal.toFixed(2)}</strong></p>
      <p><strong>Référence :</strong> ${orderRef}</p>
      <p>Confirmez le paiement dans le tableau de bord pour envoyer les codes QR.</p>
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Tableau de bord</a>
    `)
  });
}

async function sendRappelAdhesion(user) {
  const planName = { bienfaiteur: 'Bienfaiteur', partenaire: 'Partenaire' }[user.plan] || user.plan;
  await sendMail({
    to: user.email,
    subject: `Renouvellement de votre adhésion ${planName} | AHH`,
    html: wrap('Renouvellement d\'adhésion', `
      <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
      <p>Il est temps de renouveler votre adhésion <strong>${planName}</strong> à l'Association Haïtienne de Hamilton pour continuer à profiter de tous les avantages liés à votre plan.</p>
      <p>Connectez-vous à votre espace membre pour effectuer votre paiement :</p>
      <a href="${siteUrl}/dashboard/app.html" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;font-family:Arial,sans-serif">Renouveler mon adhésion</a>
      <hr class="divider"/>
      <p style="font-size:.82rem;color:#888">Des questions ? Contactez-nous à <a href="mailto:contact@ahhamilton.ca">contact@ahhamilton.ca</a></p>
    `)
  });
}

// ── Courriel externe depuis le comité ────────────────────────────────────
async function sendExternalEmail({ to, subject, bodyHtml, senderName, senderEmail, orgEmail, orgSmtpPass }) {
  const html = wrap(subject,
    `<p>Bonjour,</p>
     ${bodyHtml}
     <hr class="divider"/>
     <p style="font-size:.8rem;color:#888">
       Ce message vous a été envoyé par <strong>${senderName}</strong>
       au nom de l'<strong>Association Haïtienne de Hamilton</strong>.<br/>
       Pour répondre, écrivez à : <a href="mailto:${orgEmail || senderEmail || 'contact@ahhamilton.ca'}">${orgEmail || senderEmail || 'contact@ahhamilton.ca'}</a>
     </p>`
  );

  // Utiliser le mot de passe commun si pas de mot de passe individuel
  const effectivePass = orgSmtpPass || ORG_SMTP_PASS;

  // Tentative via le compte @ahhamilton.ca du membre
  // Essaie SSL/465 d'abord (Hostinger), puis STARTTLS/587 en fallback
  if (orgEmail && effectivePass) {
    for (const [port, secure] of [[465, true],[587, false]]) {
      try {
        const t = nodemailer.createTransport({
          host: SMTP_HOST, port, secure,
          auth: { user: orgEmail, pass: effectivePass },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 10000, socketTimeout: 15000
        });
        await t.verify();
        const from = `"${senderName} | AHH" <${orgEmail}>`;
        const plainText = html.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
        await t.sendMail({ from, to, subject, html, text: plainText });
        console.log(`✉️  Email envoyé (org ${orgEmail} port ${port}) → ${to} | ${subject}`);
        return;
      } catch(e) {
        console.error(`[sendExternalEmail] ${orgEmail} port ${port}: ${e.message}`);
      }
    }
    // Les deux ports ont échoué avec le compte personnel
    console.warn(`[sendExternalEmail] Tous les ports SMTP échoués pour ${orgEmail} — fallback contact@`);
  }

  // Fallback : compte principal contact@ahhamilton.ca
  const t = getTransporter();
  if (!t) throw new Error('SMTP non configuré sur le serveur. Contactez l\'administrateur système ou configurez votre adresse @ahhamilton.ca dans votre profil.');

  const from    = `"${senderName} | AHH" <${SMTP_USER}>`;
  const replyTo = orgEmail    ? `"${senderName}" <${orgEmail}>` :
                  senderEmail ? `"${senderName}" <${senderEmail}>` : FROM;
  const plainText = html.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  await t.sendMail({ from, to, replyTo, subject, html, text: plainText });
  console.log(`✉️  Email envoyé (fallback ${SMTP_USER}) → ${to} | ${subject}`);
}

async function sendCarteRenewal(user, expirationDate) {
  const siteUrl = process.env.SITE_URL || 'https://ahhamilton.ca';
  const to      = user.email;
  const subject = '🪪 Renouvellement de votre carte membre AHH Hamilton';
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:auto">
      <div style="background:linear-gradient(135deg,#1565c0,#1a237e);border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;color:#fff">
        <div style="font-size:2rem;margin-bottom:8px">🪪</div>
        <h2 style="margin:0;font-size:1.3rem">Renouvellement de carte membre</h2>
      </div>
      <div style="background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px;padding:28px 32px">
        <p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
        <p>Votre carte de membre AHH Hamilton arrive à expiration le <strong>${new Date(expirationDate).toLocaleDateString('fr-CA', {year:'numeric',month:'long',day:'numeric'})}</strong>.</p>
        <p>Pour continuer à profiter de tous vos avantages membres, veuillez contacter l'équipe AHH Hamilton ou vous connecter à votre espace membre pour effectuer le renouvellement.</p>
        <div style="text-align:center;margin:24px 0">
          <a href="${siteUrl}/dashboard.html" style="background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">
            Accéder à mon espace membre
          </a>
        </div>
        <p style="font-size:.85rem;color:#666">Si vous avez des questions, répondez directement à cet email ou contactez-nous à <a href="mailto:contact@ahhamilton.ca">contact@ahhamilton.ca</a>.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="font-size:.78rem;color:#999;text-align:center">AHH Hamilton | Association Haïtienne de Hamilton</p>
      </div>
    </div>`;
  return sendMail({ to, subject, html });
}

async function sendRappelExpiration(user, joursRestants, montant, mois) {
  const urgence = joursRestants <= 1 ? '🚨 DERNIER JOUR' : joursRestants <= 7 ? '⚠️ Urgent' : '📅 Rappel';
  const label = joursRestants <= 1 ? 'aujourd\'hui' : joursRestants <= 7 ? `dans ${joursRestants} jours` : 'dans 30 jours';
  await sendMail({
    to: user.email,
    subject: `${urgence} — Cotisation ${mois} : paiement dû ${label}`,
    html: wrap(
      `${urgence} — Votre cotisation expire ${label}`,
      `<p>Bonjour <strong>${user.prenom}</strong>,</p>
       <p>Votre cotisation <strong>${user.plan}</strong> pour le mois de <strong>${mois}</strong> est due <strong>${label}</strong>.</p>
       <p>Montant : <strong>${(montant/100).toFixed(2)} $</strong></p>
       ${joursRestants <= 1 ? '<p style="color:#c62828;font-weight:700">⚠️ Sans paiement aujourd\'hui, votre plan sera rétrogradé.</p>' : ''}
       <a class="btn" href="${siteUrl}/dashboard/app.html">💳 Payer ma cotisation</a>
       <hr class="divider"/>
       <p style="font-size:.82rem;color:#888">Vous pouvez payer en ligne par carte ou soumettre une preuve de virement dans votre espace membre.</p>`
    )
  });
}

async function sendRecuFiscalAuto(user, montant, mois, recuId) {
  const annee = mois.substring(0, 4);
  const moisLabel = new Date(mois + '-01').toLocaleDateString('fr-CA', { year:'numeric', month:'long' });
  await sendMail({
    to: user.email,
    subject: `Reçu de paiement — Cotisation ${moisLabel}`,
    html: wrap(
      'Reçu de paiement confirmé',
      `<p>Bonjour <strong>${user.prenom} ${user.nom}</strong>,</p>
       <p>Nous confirmons la réception de votre paiement de cotisation.</p>
       <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:.88rem">
         <tr style="background:#f0f7f0"><td style="padding:8px 12px;font-weight:600">Reçu no.</td><td style="padding:8px 12px">#${String(recuId).padStart(5,'0')}</td></tr>
         <tr><td style="padding:8px 12px;font-weight:600">Membre</td><td style="padding:8px 12px">${user.prenom} ${user.nom}</td></tr>
         <tr style="background:#f0f7f0"><td style="padding:8px 12px;font-weight:600">Plan</td><td style="padding:8px 12px">${user.plan}</td></tr>
         <tr><td style="padding:8px 12px;font-weight:600">Période</td><td style="padding:8px 12px">${moisLabel}</td></tr>
         <tr style="background:#f0f7f0"><td style="padding:8px 12px;font-weight:600">Montant</td><td style="padding:8px 12px;font-weight:700;color:#1b5e20">${(montant/100).toFixed(2)} $ CAD</td></tr>
         <tr><td style="padding:8px 12px;font-weight:600">Date</td><td style="padding:8px 12px">${new Date().toLocaleDateString('fr-CA')}</td></tr>
       </table>
       <p style="font-size:.82rem;color:#555">Ce reçu est disponible dans votre espace membre sous <strong>Mon paiement → Historique</strong>.</p>
       <a class="btn" href="${siteUrl}/dashboard/app.html">Voir mon espace</a>`
    )
  });
}

async function sendAnniversaire(user) {
  const prenom = user.prenom || 'cher membre';
  const html = wrap(`🎂 Joyeux anniversaire, ${prenom} !`,
    `<p>Bonjour <strong>${prenom}</strong>,</p>
     <p>En ce jour spécial, toute l'équipe de l'<strong>Association Haïtienne de Hamilton</strong>
     vous souhaite un très joyeux anniversaire ! 🎉</p>
     <p>Que cette nouvelle année vous apporte santé, bonheur et de belles réussites,
     entouré(e) de vos proches et de notre grande famille haïtienne à Hamilton.</p>
     <p style="font-size:1.3rem;text-align:center;margin:20px 0">🇭🇹 🎂 🎊</p>
     <p>Avec toute notre affection,<br/>
     <strong>Le Comité de l'Association Haïtienne de Hamilton</strong></p>
     <hr class="divider"/>
     <p style="font-size:.8rem;color:#888">
       Connectez-vous à votre espace membre pour voir les messages de la communauté.<br/>
       <a href="${siteUrl}/dashboard/login.html" style="color:#2e7d32">Mon espace membre →</a>
     </p>`
  );
  await sendMail({ to: user.email, subject: `🎂 Joyeux anniversaire, ${prenom} ! — AHH`, html });
}

module.exports = {
  sendMail, sendSMS, sendBienvenue, sendInscriptionRefusee, sendResetPassword,
  sendContact, sendRappelPaiement, sendPaiementApprouve, sendRappelAdhesion,
  sendRecuFiscal, sendRecuFiscalAuto, sendRappelExpiration,
  sendInscriptionActivite, sendNouvelleAdhesion, sendInvitation, sendHeuresBenevolat,
  sendBilletInterac, sendBilletQR, sendNouvelleCommandeBillet, sendExternalEmail,
  sendCarteRenewal, sendAnniversaire, SMS_GATEWAYS
};
