// TV board: big ready numbers for everyone at the counter, with a chime when a new one lands.
(function () {
  const W = window.Waitzi;
  const $ = id => document.getElementById(id);
  const s = { prep: [], ready: [], offset: 0, sound: false, seen: null };
  let wakeLock = null;

  // Browsers only allow sound, fullscreen and wake lock after a tap, so ask once.
  $('start').addEventListener('click', async () => {
    W.ensureAudio();
    s.sound = true;
    $('start').hidden = true;
    try { await document.documentElement.requestFullscreen(); } catch (e) {}
    keepAwake();
  });
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (s.sound) keepAwake(); });

  function connect() {
    const es = new EventSource('/api/board/events');
    es.onmessage = e => {
      $('conn').hidden = true;
      const d = JSON.parse(e.data);
      s.offset = d.now - Date.now();
      // Chime for numbers that just turned ready (and ones paged again), not on first load.
      const fresh = new Set();
      if (s.seen) for (const r of d.ready) if (s.seen.get(r.n) !== r.readyAt) fresh.add(r.n);
      s.seen = new Map(d.ready.map(r => [r.n, r.readyAt]));
      s.prep = d.prep; s.ready = d.ready;
      render(fresh);
      if (fresh.size && s.sound) W.beep();
    };
    es.onerror = () => { $('conn').hidden = false; };
  }

  const tiles = new Map();
  function render(fresh) {
    const box = $('ready');
    const keep = new Set(s.ready.map(r => r.n));
    for (const [n, el] of tiles) if (!keep.has(n)) { el.remove(); tiles.delete(n); }
    s.ready.forEach((r, i) => {
      let el = tiles.get(r.n);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tile';
        el.innerHTML = '<span class="dot led"></span><span class="num"></span>';
        el.querySelector('.num').textContent = r.n;
        tiles.set(r.n, el);
      }
      if (fresh.has(r.n)) { el.classList.remove('fresh'); void el.offsetWidth; el.classList.add('fresh'); }
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });

    // Fewer numbers get bigger tiles, so a single ready order reads from across the room.
    const c = s.ready.length;
    const [cell, num] = c <= 1 ? ['40vw', '20vw'] : c <= 4 ? ['26vw', '13vw'] : c <= 9 ? ['18vw', '8.5vw'] : ['13vw', '6vw'];
    box.style.setProperty('--cell', cell);
    box.style.setProperty('--num', num);

    $('readyEmpty').hidden = c > 0;
    box.hidden = c === 0;
    $('readyCount').textContent = c ? c + ' waiting' : '';
    $('prep').innerHTML = s.prep.map(n => '<div class="num p">' + n + '</div>').join('');
    $('prepCount').textContent = s.prep.length ? s.prep.length + ' orders' : '';
  }

  setInterval(() => { $('clock').textContent = W.hhmm(Date.now() + s.offset); }, 1000);
  $('clock').textContent = W.hhmm(Date.now());
  connect();
})();
