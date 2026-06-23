const http = require('http');

const BASE = 'http://localhost:3001';
let token = '';
let passed = 0;
let failed = 0;
let total = 0;

async function request(method, path, body, useToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const options = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' }
    };
    if (useToken && token) options.headers.Authorization = 'Bearer ' + token;
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function test(name, fn) {
  total++;
  return fn().then(() => { passed++; console.log('  ✅ ' + name); })
    .catch(e => { failed++; console.log('  ❌ ' + name + ' — ' + e.message); });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function run() {
  console.log('\n🧪 Tests API — AHH Hamilton\n');

  // Auth
  await test('POST /api/auth/login — valid credentials', async () => {
    const r = await request('POST', '/api/auth/login', { email: 'secretaire@ahhamilton.ca', password: 'AHH2026!' });
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.token, 'No token returned');
    token = r.body.token;
  });

  await test('POST /api/auth/login — wrong password', async () => {
    const r = await request('POST', '/api/auth/login', { email: 'secretaire@ahhamilton.ca', password: 'wrong' });
    assert(r.status === 401 || r.status === 400, 'Expected 401/400, got ' + r.status);
  });

  await test('GET /api/auth/me — with token', async () => {
    const r = await request('GET', '/api/auth/me', null, true);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.prenom, 'No prenom returned');
  });

  await test('GET /api/auth/me — without token', async () => {
    const r = await request('GET', '/api/auth/me');
    assert(r.status === 401, 'Expected 401, got ' + r.status);
  });

  // Stats
  await test('GET /api/stats — dashboard stats', async () => {
    const r = await request('GET', '/api/stats', null, true);
    assert(r.status === 200, 'Expected 200');
    assert(typeof r.body.total_membres === 'number', 'Missing total_membres');
  });

  // Activities
  await test('GET /api/activities — list', async () => {
    const r = await request('GET', '/api/activities', null, true);
    assert(r.status === 200);
    assert(Array.isArray(r.body), 'Expected array');
  });

  // Notes
  await test('GET /api/notes — list', async () => {
    const r = await request('GET', '/api/notes', null, true);
    assert(r.status === 200);
    assert(Array.isArray(r.body), 'Expected array');
  });

  // Public endpoints
  await test('GET /api/activities/public — no auth needed', async () => {
    const r = await request('GET', '/api/activities/public');
    assert(r.status === 200);
  });

  await test('GET /api/stats/public — no auth needed', async () => {
    const r = await request('GET', '/api/stats/public');
    assert(r.status === 200);
  });

  await test('GET /sitemap.xml — sitemap', async () => {
    const r = await request('GET', '/sitemap.xml');
    assert(r.status === 200);
  });

  await test('POST /api/chatbot — FAQ bot', async () => {
    const r = await request('POST', '/api/chatbot', { message: 'bonjour' });
    assert(r.status === 200);
    assert(r.body.reply, 'No reply');
  });

  // Countdown
  await test('GET /api/countdown — public config', async () => {
    const r = await request('GET', '/api/countdown');
    assert(r.status === 200);
  });

  // Members search
  await test('GET /api/members/search?q=jean — search', async () => {
    const r = await request('GET', '/api/members/search?q=jean', null, true);
    assert(r.status === 200);
    assert(Array.isArray(r.body));
  });

  // Tasks
  await test('GET /api/tasks — list', async () => {
    const r = await request('GET', '/api/tasks', null, true);
    assert(r.status === 200);
    assert(Array.isArray(r.body));
  });

  // Forms
  await test('GET /api/forms — list', async () => {
    const r = await request('GET', '/api/forms', null, true);
    assert(r.status === 200);
    assert(Array.isArray(r.body));
  });

  // Calendar feed
  await test('GET /api/calendar/feed.ics — iCal', async () => {
    const r = await request('GET', '/api/calendar/feed.ics');
    assert(r.status === 200);
  });

  // Summary
  console.log('\n' + '═'.repeat(40));
  console.log('  Total: ' + total + ' | ✅ ' + passed + ' | ❌ ' + failed);
  console.log('═'.repeat(40) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
