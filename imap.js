require('dotenv').config();
const { ImapFlow } = require('imapflow');

const { IMAP_HOST, IMAP_PORT } = process.env;

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

      // Fetch envelope + flags only — no source/body in list fetch (avoids FETCH errors on malformed messages)
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true, flags: true, envelope: true
      })) {
        emails.push({
          uid: msg.uid,
          date: msg.envelope?.date?.toISOString() || new Date().toISOString(),
          from: msg.envelope?.from?.[0]?.address || '',
          fromName: msg.envelope?.from?.[0]?.name || '',
          subject: msg.envelope?.subject || '(sans objet)',
          seen: msg.flags?.has('\\Seen') || false,
          body: ''
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

async function fetchEmailBody(emailAddr, password, uid) {
  if (!IMAP_HOST || !emailAddr || !password) return '';

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: parseInt(IMAP_PORT) || 993,
    secure: true,
    auth: { user: emailAddr, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  let body = '';
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Try TEXT body part first; fall back to full source on failure
      let text = '';
      try {
        const msg = await client.fetchOne(`${uid}`, { bodyParts: ['TEXT'] }, { uid: true });
        text = msg.bodyParts?.get('TEXT')?.toString() || '';
      } catch {
        const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
        const src = msg.source?.toString() || '';
        const m = src.match(/\r?\n\r?\n([\s\S]*)/);
        text = m ? m[1] : src;
      }
      body = text.replace(/<[^>]+>/g, '').replace(/\r?\n/g, '\n').trim().substring(0, 4000);
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('[IMAP] fetchEmailBody error:', e.message);
  }
  return body;
}

module.exports = { fetchEmails, fetchEmailBody };
