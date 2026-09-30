'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waitzi-'));
process.env.DATA_FILE = path.join(dir, 'state.json');
process.env.STAFF_KEY = 'secret';
const { server, pusher } = require('../server');

// Plain tests instead of before/after hooks: top-level hooks don't run on Node 18.
let base;
test('start server', () => new Promise(r => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));

const staff = (p, body) => fetch(base + '/api/staff' + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Staff-Key': 'secret' }, body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

// Read the first N SSE messages from a stream.
async function events(url, count, during) {
  const ctrl = new AbortController();
  const res = await fetch(base + url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const out = [];
  let buf = '';
  const done = (async () => {
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) out.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  if (during) await during();
  await done;
  ctrl.abort();
  return out;
}

test('staff API requires the key', async () => {
  const r = await fetch(base + '/api/staff/state');
  assert.strictEqual(r.status, 401);
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.strictEqual(cfg.staffAuth, true);
});

test('full order flow: create → join → ready → page again → collect', async () => {
  const { body: { n } } = await staff('/orders', { name: 'Jonas' });
  assert.strictEqual(n, 1);

  const miss = await fetch(base + '/api/orders/999/join', { method: 'POST' });
  assert.strictEqual(miss.status, 404);

  const join = await (await fetch(base + '/api/orders/1/join', { method: 'POST' })).json();
  assert.strictEqual(join.order.status, 'prep');
  assert.strictEqual(join.order.phone, true);
  assert.strictEqual(join.order.name, 'Jonas');

  const msgs = await events('/api/orders/1/events', 3, async () => {
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual((await staff('/orders/1/ready')).status, 200);
    assert.strictEqual((await staff('/orders/1/page')).status, 200);
  });
  assert.deepStrictEqual(msgs.map(m => [m.order.status, m.order.pages]), [['prep', 0], ['ready', 1], ['ready', 2]]);

  const got = await fetch(base + '/api/orders/1/collect', { method: 'POST' });
  assert.strictEqual(got.status, 200);
  const state = await (await fetch(base + '/api/staff/state', { headers: { 'X-Staff-Key': 'secret' } })).json();
  assert.strictEqual(state.orders.length, 0);
  assert.strictEqual(state.collectedToday, 1);

  // Collected orders can't be joined again.
  assert.strictEqual((await fetch(base + '/api/orders/1/join', { method: 'POST' })).status, 404);
});

test('undo returns a paged order to preparing', async () => {
  const { body: { n } } = await staff('/orders');
  assert.strictEqual((await staff('/orders/' + n + '/ready')).status, 200);
  assert.strictEqual((await staff('/orders/' + n + '/undo')).status, 200);
  assert.strictEqual((await staff('/orders/' + n + '/page')).status, 409);
  const state = await (await fetch(base + '/api/staff/state', { headers: { 'X-Staff-Key': 'secret' } })).json();
  assert.strictEqual(state.orders.find(o => o.n === n).status, 'prep');
});

test('customer cannot collect an order that is not ready', async () => {
  const { body: { n } } = await staff('/orders');
  assert.strictEqual((await fetch(base + '/api/orders/' + n + '/collect', { method: 'POST' })).status, 409);
});

test('ready and page again push to subscribed phones; dead subscriptions are dropped', async () => {
  const sent = [];
  pusher.send = async (sub, payload) => {
    sent.push([sub.endpoint, JSON.parse(payload)]);
    if (sub.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
  };
  const { body: { n } } = await staff('/orders', { name: 'Ida', eta: 480 });
  const sub = ep => fetch(base + '/api/orders/' + n + '/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint: ep, keys: { p256dh: 'k', auth: 'a' } } }),
  });
  assert.strictEqual((await sub('http://insecure.example/x')).status, 400);
  assert.strictEqual((await sub('https://push.example/ok')).status, 200);
  assert.strictEqual((await sub('https://push.example/gone')).status, 200);

  await staff('/orders/' + n + '/ready');
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(sent.map(x => x[0]).sort(), ['https://push.example/gone', 'https://push.example/ok']);
  assert.strictEqual(sent[0][1].title, 'Order ' + n + ' is ready');

  sent.length = 0;
  await staff('/orders/' + n + '/page');
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(sent.map(x => x[0]), ['https://push.example/ok']);
  assert.strictEqual(sent[0][1].pages, 2);

  const cfg = await (await fetch(base + '/api/config')).json();
  assert.match(cfg.pushKey, /^[A-Za-z0-9_-]{80,}$/);
  const state = await (await fetch(base + '/api/staff/state', { headers: { 'X-Staff-Key': 'secret' } })).json();
  const o = state.orders.find(x => x.n === n);
  assert.strictEqual(o.eta, 480);
  assert.strictEqual(o.subs, undefined); // subscriptions never leave the server
});

test('collected orders land in history, with who confirmed them', async () => {
  const a = (await staff('/orders', { name: 'Mia' })).body.n;
  const b = (await staff('/orders')).body.n;
  await staff('/orders/' + a + '/ready');
  await staff('/orders/' + b + '/ready');
  await staff('/orders/' + a + '/collect');
  await fetch(base + '/api/orders/' + b + '/collect', { method: 'POST' });

  assert.strictEqual((await fetch(base + '/api/staff/history')).status, 401);
  const h = await (await fetch(base + '/api/staff/history', { headers: { 'X-Staff-Key': 'secret' } })).json();
  assert.strictEqual(h.day, h.today);
  assert.deepStrictEqual(h.orders.slice(0, 2).map(x => [x.n, x.by]), [[b, 'phone'], [a, 'counter']]);
  assert.strictEqual(h.orders[1].name, 'Mia');
  assert.ok(h.orders[1].readyAt && h.orders[1].collectedAt >= h.orders[1].readyAt);
  assert.strictEqual(h.orders[0].subs, undefined);

  const other = await (await fetch(base + '/api/staff/history?day=2000-01-01', { headers: { 'X-Staff-Key': 'secret' } })).json();
  assert.deepStrictEqual(other.orders, []);
});

test('undoing Collected puts the order back on the counter and out of history', async () => {
  const hist = async () => (await (await fetch(base + '/api/staff/history', { headers: { 'X-Staff-Key': 'secret' } })).json()).orders;
  const n = (await staff('/orders')).body.n;
  await staff('/orders/' + n + '/ready');
  const before = (await hist()).length;
  await staff('/orders/' + n + '/collect');
  assert.strictEqual((await hist()).length, before + 1);
  assert.strictEqual((await staff('/orders/' + n + '/uncollect')).status, 200);
  assert.strictEqual((await hist()).length, before);
  const st = await (await fetch(base + '/api/staff/state', { headers: { 'X-Staff-Key': 'secret' } })).json();
  assert.strictEqual(st.orders.find(o => o.n === n).status, 'ready');
  assert.strictEqual((await staff('/orders/' + n + '/uncollect')).status, 409); // only once
});

test('customers see their place in line; the board shows numbers only', async () => {
  const a = (await staff('/orders', { name: 'Secret Name' })).body.n;
  await new Promise(r => setTimeout(r, 5));
  const b = (await staff('/orders')).body.n;
  const ja = await (await fetch(base + '/api/orders/' + a + '/join', { method: 'POST' })).json();
  const jb = await (await fetch(base + '/api/orders/' + b + '/join', { method: 'POST' })).json();
  assert.strictEqual(jb.order.ahead, ja.order.ahead + 1);

  const [snap] = await events('/api/board/events', 1);
  assert.ok(snap.prep.includes(a) && snap.prep.includes(b));
  assert.ok(!JSON.stringify(snap).includes('Secret Name'));
});

test('serves pages and the QR code', async () => {
  for (const p of ['/', '/staff', '/history', '/history.js', '/board', '/board.js', '/card', '/app.css', '/manifest.webmanifest', '/sw.js']) {
    assert.strictEqual((await fetch(base + p)).status, 200, p);
  }
  const qr = await fetch(base + '/qr.svg');
  assert.match(await qr.text(), /<svg/);
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
});

test('stop server', () => { server.closeAllConnections?.(); server.close(); });
