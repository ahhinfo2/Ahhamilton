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
    console.log(`[IMAP] Connecté à ${emailAddr}`);
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      console.log(`[IMAP] ${total} messages dans INBOX`);
      if (total === 0) return [];
      const start = Math.max(1, total - 49);
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true, flags: true, envelope: true, source: true
      })) {
        const text = msg.source?.toString() || '';
        const bodyMatch = text.match(/\r?\n\r?\n([\s\S]*)/);
        const rawBody = bodyMatch ? bodyMatch[1] : '';
        const body = rawBody.replace(/<[^>]+>/g, '').replace(/\r?\n/g, '\n').trim().substring(0, 2000);
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
    console.log(`[IMAP] ${emails.length} emails récupérés`);
  } catch (e) {
    console.error('[IMAP] Erreur:', e.message);
    throw e;
  }
  return emails.reverse();
}

module.exports = { fetchEmails };
