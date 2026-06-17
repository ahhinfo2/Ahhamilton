require('dotenv').config();
const { ImapFlow } = require('imapflow');

const { IMAP_HOST, IMAP_PORT } = process.env;

// Cache results 60 s and deduplicate concurrent requests per account
const _cache    = new Map(); // emailAddr → { ts, emails }
const _inFlight = new Map(); // emailAddr → Promise
const CACHE_TTL = 20_000;

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
  if (!IMAP_HOST || !emailAddr || !password) return { html: '', text: '' };

  const client = _makeClient(emailAddr, password);
  let result = { html: '', text: '' };
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      const src = msg?.source?.toString('utf-8') || '';
      const parsed = _parseMimeBody(src);
      result = {
        html: (parsed.html || '').substring(0, 200000),
        text: (parsed.text || '').substring(0, 8000)
      };
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('[IMAP] fetchEmailBody error:', e.message);
    try { await client.logout(); } catch {}
  }
  return result;
}

// ── Extraction du corps depuis source MIME brute ──────────────────────────
function _parseMimeBody(src) {
  if (!src) return { html: '', text: '' };
  const sepIdx = src.search(/\r?\n\r?\n/);
  if (sepIdx < 0) return { html: '', text: '' };
  const headers = src.slice(0, sepIdx);
  const rawBody = src.slice(sepIdx + src.slice(sepIdx).match(/^\r?\n\r?\n/)[0].length);
  return _parsePart(headers, rawBody);
}

function _parsePart(headers, body) {
  const ct   = (headers.match(/^Content-Type:\s*([^\r\n]+(?:\r?\n[ \t][^\r\n]+)*)/im) || [])[1] || '';
  const enc  = (headers.match(/^Content-Transfer-Encoding:\s*(\S+)/im) || [])[1] || '';
  const bndM = ct.match(/boundary="?([^";\r\n]+)"?/i);

  if (bndM) {
    // Multipart : boundary peut avoir un suffixe (-Part_1 etc.)
    const bnd   = bndM[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Diviser sur n'importe quelle ligne commençant par --boundary (avec ou sans suffixe)
    const parts = body.split(new RegExp('[ \\t]*--' + bnd + '[^\\r\\n]*\\r?\\n'));
    let html = '', text = '';
    for (const p of parts) {
      if (!p || p.trimStart().startsWith('--')) continue;
      const si = p.search(/\r?\n\r?\n/);
      if (si < 0) continue;
      const ph  = p.slice(0, si);
      const pb  = p.slice(si + p.slice(si).match(/^\r?\n\r?\n/)[0].length).replace(/\r?\n--[^\r\n]*$/, '');
      const pct = (ph.match(/^Content-Type:\s*([^\r\n;]+)/im) || [])[1]?.trim().toLowerCase() || '';
      const pe  = (ph.match(/^Content-Transfer-Encoding:\s*(\S+)/im) || [])[1] || '';

      if (pct.startsWith('multipart/')) {
        const sub = _parsePart(ph, pb);
        if (!html && sub.html) html = sub.html;
        if (!text && sub.text) text = sub.text;
      } else if (pct.startsWith('text/plain') && !text) {
        text = _decode(pb, pe).trim();
      } else if (pct.startsWith('text/html') && !html) {
        html = _decode(pb, pe);
      }
    }
    return { html, text };
  }

  // Message simple (non multipart)
  const decoded = _decode(body, enc);
  if (ct.toLowerCase().includes('text/html')) {
    return { html: decoded, text: _stripHtml(decoded) };
  }
  return { html: '', text: decoded.trim() };
}

function _decode(text, enc) {
  const e = (enc || '').toLowerCase();
  if (e === 'quoted-printable') {
    return text.replace(/=\r?\n/g, '').replace(/=[0-9A-F]{2}/gi, m => String.fromCharCode(parseInt(m.slice(1), 16)));
  }
  if (e === 'base64') {
    try { return Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch { return text; }
  }
  return text;
}

function _stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
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

async function markAsRead(emailAddr, password, uid) {
  if (!IMAP_HOST || !emailAddr || !password) return;

  const client = _makeClient(emailAddr, password);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(`${uid}`, ['\\Seen'], { uid: true });
      // Update cache in-place so the list reflects the change without a full refetch
      const hit = _cache.get(emailAddr);
      if (hit) {
        const m = hit.emails.find(x => x.uid === uid);
        if (m) m.seen = true;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('[IMAP] markAsRead error:', e.message);
    try { await client.logout(); } catch {}
  }
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

async function deleteBulk(emailAddr, password, uids) {
  if (!IMAP_HOST || !emailAddr || !password || !uids?.length) return 0;

  const client = _makeClient(emailAddr, password);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Une seule commande IMAP pour N messages (beaucoup plus rapide que N appels)
      await client.messageDelete(uids.map(String).join(','), { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    invalidateCache(emailAddr);
    console.log(`[IMAP] ${uids.length} message(s) deleted from ${emailAddr}`);
    return uids.length;
  } catch (e) {
    console.error('[IMAP] deleteBulk error:', e.message);
    try { await client.logout(); } catch {}
    throw e;
  }
}

// Invalidate cache for an account (call after sending a reply)
function invalidateCache(emailAddr) {
  _cache.delete(emailAddr);
}

module.exports = { fetchEmails, fetchEmailBody, markAsRead, deleteEmail, deleteBulk, invalidateCache };
