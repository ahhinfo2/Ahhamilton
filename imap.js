require('dotenv').config();
const { ImapFlow } = require('imapflow');

const { IMAP_HOST, IMAP_PORT } = process.env;

// Cache results 60 s and deduplicate concurrent requests per account
const _cache    = new Map(); // emailAddr → { ts, emails }
const _inFlight = new Map(); // emailAddr → Promise
const CACHE_TTL = 60_000;

async function fetchEmails(emailAddr, password) {
  if (!IMAP_HOST || !emailAddr || !password) return [];

  // Serve from cache if fresh
  const hit = _cache.get(emailAddr);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    console.log(`[IMAP] cache hit for ${emailAddr} (${hit.emails.length} msgs)`);
    return hit.emails;
  }

  // Deduplicate: if a fetch is already in progress for this account, wait for it
  if (_inFlight.has(emailAddr)) {
    console.log(`[IMAP] piggyback on in-flight fetch for ${emailAddr}`);
    return _inFlight.get(emailAddr);
  }

  const promise = _doFetch(emailAddr, password);
  _inFlight.set(emailAddr, promise);
  try {
    const emails = await promise;
    _cache.set(emailAddr, { ts: Date.now(), emails });
    return emails;
  } finally {
    _inFlight.delete(emailAddr);
  }
}

async function _doFetch(emailAddr, password) {
  const client = _makeClient(emailAddr, password);
  const emails = [];
  try {
    console.log(`[IMAP] connecting to ${emailAddr}…`);
    await client.connect();
    console.log(`[IMAP] connected, opening INBOX…`);

    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox?.exists || 0;
      console.log(`[IMAP] INBOX has ${total} messages`);
      if (total > 0) {
        const start = Math.max(1, total - 49);
        console.log(`[IMAP] fetching seq ${start}:*…`);
        for await (const msg of client.fetch(`${start}:*`, {
          uid: true, flags: true, envelope: true
        })) {
          emails.push({
            uid:      msg.uid,
            date:     msg.envelope?.date?.toISOString() || new Date().toISOString(),
            from:     msg.envelope?.from?.[0]?.address || '',
            fromName: msg.envelope?.from?.[0]?.name || '',
            subject:  msg.envelope?.subject || '(sans objet)',
            seen:     msg.flags?.has('\\Seen') || false,
            body:     ''
          });
        }
        console.log(`[IMAP] fetched ${emails.length} envelopes OK`);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error(`[IMAP] _doFetch error for ${emailAddr}:`, e.message);
    try { await client.logout(); } catch {}
    throw e;
  }
  return emails.reverse();
}

async function fetchEmailBody(emailAddr, password, uid) {
  if (!IMAP_HOST || !emailAddr || !password) return '';

  const client = _makeClient(emailAddr, password);
  let body = '';
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let text = '';
      try {
        const msg = await client.fetchOne(`${uid}`, { bodyParts: ['TEXT'] }, { uid: true });
        text = msg?.bodyParts?.get('TEXT')?.toString() || '';
      } catch (e1) {
        console.warn('[IMAP] bodyParts TEXT failed, trying source:', e1.message);
        try {
          const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
          const src = msg?.source?.toString() || '';
          const m = src.match(/\r?\n\r?\n([\s\S]*)/);
          text = m ? m[1] : src;
        } catch (e2) {
          console.error('[IMAP] source fallback also failed:', e2.message);
        }
      }
      body = text.replace(/<[^>]+>/g, '').replace(/\r?\n/g, '\n').trim().substring(0, 4000);
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('[IMAP] fetchEmailBody error:', e.message);
    try { await client.logout(); } catch {}
  }
  return body;
}

function _makeClient(emailAddr, password) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: parseInt(IMAP_PORT) || 993,
    secure: true,
    auth: { user: emailAddr, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false },
    socketTimeout: 20000,
    connectionTimeout: 15000
  });
}

async function deleteEmail(emailAddr, password, uid) {
  if (!IMAP_HOST || !emailAddr || !password) throw new Error('Config IMAP manquante');

  const client = _makeClient(emailAddr, password);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageDelete(`${uid}`, { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    invalidateCache(emailAddr);
    console.log(`[IMAP] message uid=${uid} deleted from ${emailAddr}`);
  } catch (e) {
    console.error('[IMAP] deleteEmail error:', e.message);
    try { await client.logout(); } catch {}
    throw e;
  }
}

// Invalidate cache for an account (call after sending a reply)
function invalidateCache(emailAddr) {
  _cache.delete(emailAddr);
}

module.exports = { fetchEmails, fetchEmailBody, deleteEmail, invalidateCache };
