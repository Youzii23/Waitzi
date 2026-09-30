// Customer page: enter order number → wait quietly → the phone becomes the pager.
(function () {
  const W = window.Waitzi;
  const $ = id => document.getElementById(id);
  const app = $('app');

  const s = {
    view: 'join', entry: '', joined: null, order: null, offset: 0,
    soundOn: W.store.get('sound') !== 'off', seenPages: 0, collectedAt: null, pushOn: false,
  };
  let es = null, wakeLock = null, titleTimer = null;

  // ---------- views ----------
  function show(view) {
    if (s.view === view) return;
    s.view = view;
    document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== view; });
    document.querySelector('meta[name=theme-color]').content = view === 'ready' ? getComputedStyle(document.querySelector('.ready')).backgroundColor : '#F4F2ED';
    if (view === 'waiting' || view === 'ready') keepAwake(); else releaseAwake();
    if (view !== 'ready') stopAlarm();
    render();
  }

  // ---------- keypad ----------
  const keys = $('keys');
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(k => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key' + (k === '' ? ' blank' : k === '⌫' ? ' ghost' : '');
    b.textContent = k;
    b.setAttribute('aria-label', k === '⌫' ? 'Delete' : k);
    if (k === '') b.tabIndex = -1;
    b.addEventListener('click', () => (k === '⌫' ? del() : press(k)));
    keys.appendChild(b);
  });
  function press(d) {
    if (s.entry.length >= 3 || (s.entry === '' && d === '0')) return;
    s.entry += d; render();
  }
  function del() { s.entry = s.entry.slice(0, -1); render(); }
  document.addEventListener('keydown', e => {
    if (s.view !== 'join') return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') del();
    else if (e.key === 'Enter') submit();
  });

  // ---------- join ----------
  async function submit() {
    if (!s.entry) return;
    W.ensureAudio(); // the tap unlocks sound for later
    const perm = askPermission();
    const n = parseInt(s.entry, 10);
    try {
      const r = await fetch('/api/orders/' + n + '/join', { method: 'POST' });
      if (r.status === 404) { $('missing').textContent = s.entry; return show('notfound'); }
      if (!r.ok) throw new Error('join failed');
      const data = await r.json();
      join(n, data);
      perm.then(() => subscribePush(n));
    } catch (e) {
      // Network trouble: remember the number and keep trying in the background.
      join(n, null);
    }
  }

  function join(n, data) {
    s.joined = n;
    s.seenPages = 0;
    W.store.set('order', String(n));
    // Keep the order in the address, so Add to Home Screen (its own storage on iPhone) opens straight to it.
    history.replaceState(null, '', '/?o=' + n);
    if (data) apply(data);
    else { show('waiting'); }
    connect();
  }

  function apply(data) {
    s.offset = data.now - Date.now();
    const o = data.order;
    if (!o || o.n !== s.joined) {
      // Order is gone (collected at the counter or the number was reused tomorrow).
      if (s.view === 'ready' || (o && o.status === 'done')) return finish(o && o.collectedAt);
      return reset();
    }
    s.order = o;
    if (o.status === 'done') return finish(o.collectedAt);
    if (o.status === 'ready') {
      const first = s.view !== 'ready';
      show('ready');
      if (first || o.pages > s.seenPages) alertNow();
      s.seenPages = o.pages;
      return;
    }
    s.seenPages = o.pages;
    show('waiting');
    render();
  }

  function finish(at) {
    s.collectedAt = at || Date.now();
    s.pushOn = false;
    W.store.set('order', null);
    history.replaceState(null, '', '/');
    disconnect();
    show('done');
  }

  function reset() {
    s.joined = null; s.order = null; s.entry = ''; s.pushOn = false;
    W.store.set('order', null);
    history.replaceState(null, '', '/');
    disconnect();
    show('join');
  }

  // ---------- realtime ----------
  function connect() {
    disconnect();
    es = new EventSource('/api/orders/' + s.joined + '/events');
    es.onmessage = e => { setOffline(false); try { apply(JSON.parse(e.data)); } catch (err) {} };
    es.onopen = () => setOffline(false);
    es.onerror = () => setOffline(true);
  }
  function disconnect() { if (es) { es.close(); es = null; } setOffline(false); }
  function setOffline(v) { $('offline').hidden = !v; }
  window.addEventListener('online', () => { if (s.joined != null && (!es || es.readyState === 2)) connect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (s.joined != null && (!es || es.readyState === 2)) connect();
      if (s.view === 'waiting' || s.view === 'ready') keepAwake();
    }
  });

  // ---------- alert: beep → vibrate → light ----------
  // Repeats until the customer taps Stop alarm or I've got it, like a real pager.
  let alarmTimer = null;
  function alertNow() {
    W.ensureAudio();
    W.replay($('ignite'), 'wz-ignite 1.3s linear both');
    W.replay($('readyNum'), '');
    clearInterval(alarmTimer);
    ring();
    alarmTimer = setInterval(ring, 2000);
    $('stop').hidden = false;
    flashTitle();
    notify();
  }

  // One cycle: beep · pause · beep, real vibration where the browser allows it (Android),
  // and a shake of the whole screen everywhere, so iPhones still look like they buzz.
  function ring() {
    W.ensureAudio();
    if (s.soundOn) W.beep();
    W.vibrate();
    app.classList.remove('buzz'); void app.offsetWidth; app.classList.add('buzz');
  }

  function stopAlarm() {
    clearInterval(alarmTimer); alarmTimer = null;
    try { navigator.vibrate && navigator.vibrate(0); } catch (e) {}
    app.classList.remove('buzz');
    $('stop').hidden = true;
    stopTitle();
  }

  function flashTitle() {
    stopTitle();
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? '● Order ' + s.joined + ' is ready' : 'Waitzi';
    }, 1000);
  }
  function stopTitle() { clearInterval(titleTimer); titleTimer = null; document.title = 'Waitzi'; }

  // ---------- lock-screen alerts (Web Push) ----------
  // Android: works in the browser. iPhone: only after Add to Home Screen (iOS 16.4+).
  const pushable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

  // Must be called straight from a tap: browsers only show the permission prompt then.
  function askPermission() {
    try {
      if (pushable && Notification.permission === 'default') return Promise.resolve(Notification.requestPermission());
    } catch (e) {}
    return Promise.resolve(pushable ? Notification.permission : 'denied');
  }

  async function subscribePush(n) {
    if (!pushable || Notification.permission !== 'granted') return renderAlerts();
    try {
      const cfg = await W.config;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(cfg.pushKey) });
      const r = await fetch('/api/orders/' + n + '/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      s.pushOn = r.ok;
    } catch (e) { s.pushOn = false; }
    renderAlerts();
  }

  function urlKey(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  function renderAlerts() {
    const waiting = s.view === 'waiting';
    $('alerts').hidden = !(waiting && pushable && Notification.permission === 'default');
    $('iosHint').hidden = !(waiting && isIOS && !standalone && !pushable);
  }

  function notify() {
    if (document.visibilityState === 'visible' || s.pushOn) return;
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const opts = { body: 'Come pick it up at the counter.', tag: 'waitzi-ready', renotify: true, vibrate: [70, 90, 70, 90, 260], icon: '/icon-192.png' };
      const title = 'Order ' + s.joined + ' is ready';
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts));
      } else new Notification(title, opts);
    } catch (e) {}
  }

  // ---------- screen wake lock ----------
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) {}
  }
  function releaseAwake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

  // ---------- render ----------
  function render() {
    const entry = $('entry');
    entry.textContent = s.entry || '––';
    entry.classList.toggle('has', !!s.entry);
    $('start').classList.toggle('on', !!s.entry);

    document.querySelectorAll('[data-num]').forEach(el => { el.textContent = s.joined ?? '––'; });
    $('collectedAt').textContent = s.collectedAt ? W.hhmm(s.collectedAt) : '--:--';

    const sb = $('sound');
    sb.classList.toggle('off', !s.soundOn);
    $('soundLabel').textContent = s.soundOn ? 'Sound and vibration on' : 'Sound off · vibration and light only';

    renderAlerts();
    if (s.view === 'waiting') tick();
  }

  function tick() {
    const o = s.order;
    let rem = 600, pct = 0;
    if (o) {
      const e = (Date.now() + s.offset - o.start) / 1000;
      rem = Math.max(0, o.eta - e);
      pct = Math.min(100, (e / o.eta) * 100);
    }
    const almost = !!o && rem <= 60;
    $('waitMid').classList.toggle('almost', almost);
    $('headline').textContent = almost ? 'Almost there.' : "We're preparing your order.";
    $('sub').textContent = almost ? 'About a minute to go.' : (o && o.name ? 'Thanks, ' + o.name + '. ' : '') + "We'll buzz you when it's ready.";
    $('eta').textContent = rem <= 60 ? '< 1 min' : '~' + Math.ceil(rem / 60) + ' min';
    const ahead = o ? o.ahead || 0 : null;
    $('ahead').textContent = ahead == null ? '–' : ahead === 0 ? "You're next" : ahead + (ahead === 1 ? ' order' : ' orders') + ' ahead';
    $('progress').style.width = pct.toFixed(1) + '%';
  }
  setInterval(() => { if (s.view === 'waiting') tick(); }, 1000);

  // ---------- buttons ----------
  $('start').addEventListener('click', submit);
  $('sound').addEventListener('click', () => {
    W.ensureAudio();
    s.soundOn = !s.soundOn;
    W.store.set('sound', s.soundOn ? null : 'off');
    render();
  });
  $('stop').addEventListener('click', stopAlarm);
  $('got').addEventListener('click', async () => {
    stopAlarm();
    const n = s.joined;
    try { await fetch('/api/orders/' + n + '/collect', { method: 'POST' }); } catch (e) {}
    finish(Date.now());
  });
  $('alerts').addEventListener('click', () => {
    W.ensureAudio();
    const n = s.joined;
    askPermission().then(() => subscribePush(n));
  });
  $('another').addEventListener('click', reset);
  $('retry').addEventListener('click', () => { s.entry = ''; show('join'); });

  // ---------- boot ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const params = new URLSearchParams(location.search);
  const num = v => (/^[1-9]\d{0,2}$/.test(v || '') ? Number(v) : null);
  const saved = num(params.get('o')) || num(W.store.get('order'));
  if (saved) {
    s.joined = saved;
    W.store.set('order', String(saved));
    history.replaceState(null, '', '/?o=' + saved);
    show('waiting');
    connect();
    subscribePush(saved); // refreshes the subscription if alerts were already allowed
  } else if (num(params.get('n'))) {
    s.entry = params.get('n');
  }
  render();
})();
