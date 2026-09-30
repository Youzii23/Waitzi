// Staff dashboard: new order → mark ready (pages the customer's phone) → collected.
(function () {
  const W = window.Waitzi;
  const $ = id => document.getElementById(id);

  const s = { orders: [], collectedToday: 0, offset: 0, key: W.store.get('staffKey') || '', toast: null };
  let es = null, toastTimer = null;

  // ---------- api ----------
  function api(path, body) {
    return fetch('/api/staff' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Key': s.key },
      body: JSON.stringify(body || {}),
    }).then(r => {
      if (r.status === 401) { lock('Wrong staff key.'); throw new Error('unauthorized'); }
      return r.json();
    });
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/api/staff/events' + (s.key ? '?key=' + encodeURIComponent(s.key) : ''));
    es.onmessage = e => {
      $('conn').hidden = true;
      const d = JSON.parse(e.data);
      s.offset = d.now - Date.now();
      s.orders = d.orders;
      s.collectedToday = d.collectedToday;
      render();
    };
    es.onerror = () => {
      $('conn').hidden = false;
      // A rejected key looks like a dropped stream to EventSource, so check it explicitly.
      fetch('/api/staff/state', { headers: { 'X-Staff-Key': s.key } })
        .then(r => { if (r.status === 401) lock('Wrong staff key.'); }).catch(() => {});
    };
  }

  // ---------- staff key gate ----------
  function lock(msg) {
    if (es) { es.close(); es = null; }
    $('dash').hidden = true;
    $('gate').hidden = false;
    $('gateErr').textContent = msg || '';
    $('key').focus();
  }
  function unlock() {
    $('gate').hidden = true;
    $('dash').hidden = false;
    connect();
  }
  $('gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const k = $('key').value.trim();
    const r = await fetch('/api/staff/state', { headers: { 'X-Staff-Key': k } }).catch(() => null);
    if (!r || r.status === 401) { $('gateErr').textContent = r ? 'Wrong staff key.' : 'Could not reach the server.'; return; }
    s.key = k;
    W.store.set('staffKey', k);
    unlock();
  });

  // ---------- actions ----------
  function markReady(n) { api('/orders/' + n + '/ready').then(() => toast('#' + n + ' paged', n, true)).catch(() => {}); }
  function pageAgain(n) { api('/orders/' + n + '/page').then(() => toast('#' + n + ' paged again', n, false)).catch(() => {}); }
  function collect(n) { api('/orders/' + n + '/collect').then(() => toast('#' + n + ' collected', n, false)).catch(() => {}); }
  function undo() {
    const t = s.toast; if (!t) return;
    hideToast();
    api('/orders/' + t.n + '/undo').catch(() => {});
  }
  // ---------- new order sheet: optional name + estimated time ----------
  const ETAS = [5, 8, 10, 12, 15];
  let eta = Number(W.store.get('eta')) || 10;
  if (!ETAS.includes(eta)) eta = 10;
  ETAS.forEach(m => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'eta press'; b.textContent = m + ' min';
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => { eta = m; W.store.set('eta', String(m)); paintEtas(); });
    $('etas').appendChild(b);
  });
  function paintEtas() {
    [...$('etas').children].forEach((b, i) => b.setAttribute('aria-checked', String(ETAS[i] === eta)));
  }
  function openSheet() {
    $('name').value = '';
    paintEtas();
    $('sheet').hidden = $('scrim').hidden = false;
    $('new').setAttribute('aria-expanded', 'true');
    // Only jump into the field with a real keyboard; on a tablet the on-screen keyboard would cover the list.
    if (matchMedia('(pointer: fine)').matches) $('name').focus();
  }
  function closeSheet() {
    $('sheet').hidden = $('scrim').hidden = true;
    $('new').setAttribute('aria-expanded', 'false');
  }
  $('new').addEventListener('click', () => ($('sheet').hidden ? openSheet() : closeSheet()));
  $('scrim').addEventListener('click', closeSheet);
  $('cancel').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  $('sheet').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('name').value.trim();
    $('name').blur();
    closeSheet();
    api('/orders', { name, eta: eta * 60 })
      .then(d => toast('#' + d.n + (name ? ' · ' + name : '') + ' added · write it on the receipt', d.n, false)).catch(() => {});
  });
  $('undo').addEventListener('click', undo);

  function toast(text, n, canUndo) {
    s.toast = { text, n, canUndo };
    const el = $('toast');
    $('toastText').textContent = text;
    $('undo').hidden = !canUndo;
    el.classList.toggle('noundo', !canUndo);
    el.hidden = false;
    el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() { s.toast = null; $('toast').hidden = true; clearTimeout(toastTimer); }

  // ---------- render (keyed, so rows animate in once and taps are never lost) ----------
  const rows = { prep: new Map(), ready: new Map() };

  function prepRow(o) {
    const el = document.createElement('div');
    el.className = 'prow rise';
    el.innerHTML =
      '<div class="num"></div>' +
      '<div class="info"><div class="title"></div><div class="meta"><span class="time"></span><span class="ph"></span></div></div>' +
      '<button class="mark press" type="button"><span class="dot"></span>Mark ready</button>';
    el.querySelector('.mark').addEventListener('click', () => markReady(el._n));
    return el;
  }
  function readyRow(o) {
    const el = document.createElement('div');
    el.className = 'rrow rise';
    el.innerHTML =
      '<div class="line"><span class="dot led"></span><div class="num"></div>' +
      '<div class="info"><div class="title"></div><div class="meta"></div></div></div>' +
      '<div class="btns"><button class="again press" type="button">Page again</button><button class="collect press" type="button">Collected</button></div>';
    el.querySelector('.again').addEventListener('click', () => pageAgain(el._n));
    el.querySelector('.collect').addEventListener('click', () => collect(el._n));
    return el;
  }

  function sync(kind, list, container, make, fill) {
    const map = rows[kind];
    const keep = new Set(list.map(o => o.n));
    for (const [n, el] of map) if (!keep.has(n)) { el.remove(); map.delete(n); }
    list.forEach((o, i) => {
      let el = map.get(o.n);
      if (!el) {
        el = make(o); el._n = o.n; map.set(o.n, el);
        el.addEventListener('animationend', () => el.classList.remove('rise'), { once: true });
      }
      fill(el, o);
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    });
  }

  function set(el, sel, text) { const t = el.querySelector(sel); if (t.textContent !== text) t.textContent = text; }

  function render() {
    const now = Date.now() + s.offset;
    $('clock').textContent = W.hhmm(now);
    const prep = s.orders.filter(o => o.status === 'prep').sort((a, b) => a.start - b.start);
    const ready = s.orders.filter(o => o.status === 'ready').sort((a, b) => a.readyAt - b.readyAt);

    sync('prep', prep, $('prepList'), prepRow, (el, o) => {
      const e = (now - o.start) / 1000, late = e > o.eta;
      set(el, '.num', String(o.n));
      set(el, '.title', o.name || 'Walk-in');
      set(el, '.time', Math.max(0, Math.floor(e / 60)) + ' min' + (late ? ' · over' : ' of ' + Math.round(o.eta / 60)));
      el.querySelector('.time').classList.toggle('late', late);
      set(el, '.ph', o.phone ? 'On phone' : 'Call out');
    });
    sync('ready', ready, $('readyList'), readyRow, (el, o) => {
      const mins = Math.floor((now - o.readyAt) / 60000);
      set(el, '.num', String(o.n));
      set(el, '.title', o.name || 'Walk-in');
      set(el, '.meta', (mins < 1 ? 'Paged just now' : 'Paged ' + mins + ' min ago') + ' · ' + (o.phone ? 'On phone' : 'Call out'));
    });

    $('prepCount').textContent = prep.length;
    $('readyCount').textContent = ready.length;
    $('prepEmpty').hidden = prep.length > 0;
    $('readyEmpty').hidden = ready.length > 0;
    $('collected').textContent = s.collectedToday;
  }
  setInterval(render, 1000);

  // ---------- boot ----------
  W.config.then(cfg => {
    if (cfg.staffAuth && !s.key) return lock();
    unlock();
  });
})();
