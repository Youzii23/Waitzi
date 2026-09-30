// Shared helpers: config, alert signature (beep · pause · beep, short · short · long), formatting.
(function () {
  const W = (window.Waitzi = {});

  W.config = fetch('/api/config').then(r => r.json()).catch(() => ({ venue: 'Waitzi', staffAuth: false, signal: 'amber' }))
    .then(cfg => {
      if (cfg.signal && cfg.signal !== 'amber') document.documentElement.dataset.signal = cfg.signal;
      document.querySelectorAll('[data-venue]').forEach(el => { el.textContent = cfg.venue; });
      return cfg;
    });

  let ctx = null;
  // Must run inside a user gesture at least once, so the ready beep can play later.
  W.ensureAudio = function () {
    try {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
  };

  // Two 140 ms tones at C7, softened through a low-pass filter.
  W.beep = function () {
    const c = ctx; if (!c) return;
    const t = c.currentTime + 0.02;
    [0, 0.24].forEach(d => {
      const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
      o.type = 'square'; o.frequency.value = 2093;
      lp.type = 'lowpass'; lp.frequency.value = 3200;
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(0.07, t + d + 0.006);
      g.gain.setValueAtTime(0.07, t + d + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.14);
      o.connect(lp); lp.connect(g); g.connect(c.destination);
      o.start(t + d); o.stop(t + d + 0.16);
    });
  };

  W.vibrate = function () {
    try { navigator.vibrate && navigator.vibrate([70, 90, 70, 90, 260]); } catch (e) {}
  };

  W.hhmm = function (t) {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };

  // Restart a CSS animation on an element.
  W.replay = function (el, anim) {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = anim;
  };

  W.store = {
    get(k) { try { return localStorage.getItem('waitzi.' + k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('waitzi.' + k) : localStorage.setItem('waitzi.' + k, v); } catch (e) {} },
  };

  W.esc = function (s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
})();
