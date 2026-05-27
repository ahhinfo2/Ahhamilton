require('dotenv').config();
const { ImapFlow } = require('imapflow');

const { IMAP_HOST, IMAP_PORT, ORG_SMTP_PASS } = process.env;

async function fetchEmails(emailAddr, password) {
  if (!IMAP_HOST || !emailAddr || !password) return [];

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: parseInt(IMAP_PORT) || 993,
    secure: true,
    auth: { user: emailAddr, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  const emails = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Récupérer les 50 derniers messages
      const total = client.mailbox.exists;
      if (total === 0) return [];
      const start = Math.max(1, total - 49);
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true, flags: true, envelope: true, bodyStructure: true,
        source: { start: 0, maxLength: 5000 }
      })) {
        const text = msg.source?.toString() || '';
        const bodyMatch = text.match(/\r?\n\r?\n([\s\S]*)/);
        const body = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, '').replace(/\r?\n/g, '\n').trim().substring(0, 2000) : '';
        emails.push({
          uid: msg.uid,
          date: msg.envelope?.date?.toISOString() || new Date().toISOString(),
          from: msg.envelope?.from?.[0]?.address || '',
          fromName: msg.envelope?.from?.[0]?.name || '',
          subject: msg.envelope?.subject || '(sans objet)',
          seen: msg.flags?.has('\\Seen') || false,
          body
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('[IMAP] Erreur:', e.message);
  }
  return emails.reverse();
}

module.exports = { fetchEmails };
