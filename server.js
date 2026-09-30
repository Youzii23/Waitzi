'use strict';
// Waitzi server: serves the web apps and keeps the order queue in sync over Server-Sent Events.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const VENUE = process.env.VENUE_NAME || 'Hallen · Stand 4';
const STAFF_KEY = process.env.STAFF_KEY || '';
const SIGNAL = ['amber', 'green', 'coral'].includes(process.env.SIGNAL) ? process.env.SIGNAL : 'amber';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_ETA = 600;

// ---------- state ----------
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function freshState() {
  return { day: today(), seq: 0, collectedToday: 0, orders: [], undo: null };
}

let state = freshState();
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (raw && Array.isArray(raw.orders)) state = { ...freshState(), ...raw };
} catch (e) { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  }, 100);
}

// New day: restart numbering and counters, drop collected orders, keep anything still open.
function rollDay() {
  const d = today();
  if (state.day === d) return;
  state.day = d;
  state.seq = 0;
  state.collectedToday = 0;
  state.orders = state.orders.filter(o => o.status !== 'done');
  save();
}

function find(n) { return state.orders.find(o => o.n === n && o.status !== 'done'); }

function nextNumber() {
  const active = new Set(state.orders.filter(o => o.status !== 'done').map(o => o.n));
  let n = state.seq;
  for (let i = 0; i < 999; i++) {
    n = n >= 999 ? 1 : n + 1;
    if (!active.has(n)) break;
  }
  state.seq = n;
  // A number that comes around again starts a new order, so forget the old one.
  state.orders = state.orders.filter(o => o.n !== n);
  return n;
}

function publicOrder(o) {
  if (!o) return null;
  return {
    n: o.n, name: o.name || '', status: o.status, start: o.start, eta: o.eta,
    readyAt: o.readyAt || null, pages: o.pages || 0, collectedAt: o.collectedAt || null, phone: !!o.phone,
  };
}

function staffSnapshot() {
  return {
    now: Date.now(), venue: VENUE, collectedToday: state.collectedToday,
    orders: state.orders.filter(o => o.status !== 'done').map(publicOrder),
  };
}

// ---------- realtime ----------
const staffClients = new Set();
const orderClients = new Map(); // n -> Set(res)

function send(res, data) { res.write('data: ' + JSON.stringify(data) + '\n\n'); }

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
}

function broadcast(n) {
  const snap = staffSnapshot();
  for (const res of staffClients) send(res, snap);
  if (n != null) pushOrder(n);
}

function pushOrder(n) {
  const set = orderClients.get(n);
  if (!set) return;
  const o = state.orders.filter(x => x.n === n).pop();
  for (const res of set) send(res, { now: Date.now(), order: publicOrder(o) });
}

setInterval(() => {
  for (const res of staffClients) res.write(': ping\n\n');
  for (const set of orderClients.values()) for (const res of set) res.write(': ping\n\n');
}, 20000).unref();

// ---------- actions ----------
const actions = {
  create({ name, eta } = {}) {
    const n = nextNumber();
    const e = Math.round(Number(eta));
    state.orders.push({
      n, name: String(name || '').trim().slice(0, 40), status: 'prep', start: Date.now(),
      eta: e >= 60 && e <= 7200 ? e : DEFAULT_ETA, phone: false, pages: 0,
    });
    return n;
  },
  ready(n) {
    const o = find(n);
    if (!o || o.status !== 'prep') return false;
    o.status = 'ready'; o.readyAt = Date.now(); o.pages = (o.pages || 0) + 1;
    state.undo = n;
    return true;
  },
  undo(n) {
    const o = find(n);
    if (!o || o.status !== 'ready') return false;
    o.status = 'prep'; o.readyAt = null;
    return true;
  },
  page(n) {
    const o = find(n);
    if (!o || o.status !== 'ready') return false;
    o.readyAt = Date.now(); o.pages = (o.pages || 0) + 1;
    return true;
  },
  collect(n) {
    const o = find(n);
    if (!o) return false;
    o.status = 'done'; o.collectedAt = Date.now();
    state.collectedToday += 1;
    return true;
  },
};

// ---------- http helpers ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } });
  });
}

function staffOk(req, url) {
  if (!STAFF_KEY) return true;
  return req.headers['x-staff-key'] === STAFF_KEY || url.searchParams.get('key') === STAFF_KEY;
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
}

function serveFile(res, file, cache) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR)) { res.writeHead(404); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=300' : 'no-cache',
    });
    res.end(data);
  });
}

const PAGES = { '/': 'customer.html', '/staff': 'staff.html', '/card': 'card.html' };

// ---------- router ----------
async function handle(req, res) {
  rollDay();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;

  if (p === '/api/config') return json(res, 200, { venue: VENUE, signal: SIGNAL, staffAuth: !!STAFF_KEY, url: baseUrl(req) });

  // Staff API
  if (p.startsWith('/api/staff/')) {
    if (!staffOk(req, url)) return json(res, 401, { error: 'staff key required' });
    if (p === '/api/staff/state' && req.method === 'GET') return json(res, 200, staffSnapshot());
    if (p === '/api/staff/events' && req.method === 'GET') {
      openStream(req, res);
      staffClients.add(res);
      send(res, staffSnapshot());
      req.on('close', () => staffClients.delete(res));
      return;
    }
    if (p === '/api/staff/orders' && req.method === 'POST') {
      const n = actions.create(await readBody(req));
      save(); broadcast(n);
      return json(res, 200, { n });
    }
    if ((m = p.match(/^\/api\/staff\/orders\/(\d+)\/(ready|undo|page|collect)$/)) && req.method === 'POST') {
      const n = Number(m[1]);
      if (!actions[m[2]](n)) return json(res, 409, { error: 'order not in a state for that' });
      save(); broadcast(n);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  // Customer API
  if ((m = p.match(/^\/api\/orders\/(\d{1,3})\/join$/)) && req.method === 'POST') {
    const o = find(Number(m[1]));
    if (!o) return json(res, 404, { error: 'not found' });
    o.phone = true;
    save(); broadcast(o.n);
    return json(res, 200, { now: Date.now(), order: publicOrder(o) });
  }
  if ((m = p.match(/^\/api\/orders\/(\d{1,3})\/collect$/)) && req.method === 'POST') {
    const n = Number(m[1]);
    const o = find(n);
    if (!o || o.status !== 'ready') return json(res, 409, { error: 'not ready' });
    actions.collect(n);
    save(); broadcast(n);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/orders\/(\d{1,3})\/events$/)) && req.method === 'GET') {
    const n = Number(m[1]);
    openStream(req, res);
    if (!orderClients.has(n)) orderClients.set(n, new Set());
    orderClients.get(n).add(res);
    send(res, { now: Date.now(), order: publicOrder(state.orders.filter(x => x.n === n).pop()) });
    req.on('close', () => {
      const set = orderClients.get(n);
      if (set) { set.delete(res); if (!set.size) orderClients.delete(n); }
    });
    return;
  }

  if (p === '/qr.svg') {
    const svg = await QRCode.toString(baseUrl(req) + '/', { type: 'svg', margin: 0, color: { dark: '#141413', light: '#0000' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  if (PAGES[p]) return serveFile(res, PAGES[p], false);
  if (p === '/sw.js') return serveFile(res, 'sw.js', false);
  if (/^\/[\w.-]+$/.test(p)) return serveFile(res, p.slice(1), true);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else res.end();
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Waitzi running on http://localhost:' + PORT);
    console.log('  customers: /   staff: /staff   counter card: /card');
    if (!STAFF_KEY) console.log('  (no STAFF_KEY set — the staff dashboard is open to anyone)');
  });
}

module.exports = { server, actions, state: () => state };
