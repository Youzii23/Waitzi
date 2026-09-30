// History: collected orders per day, with cook and pickup times.
(function () {
  const W = window.Waitzi;
  const $ = id => document.getElementById(id);
  const key = W.store.get('staffKey') || '';
  const s = { day: null, today: null, days: [], orders: [] };
  let es = null, lastCollected = null;

  function load(day) {
    const q = day ? '?day=' + day : '';
    return fetch('/api/staff/history' + q, { headers: { 'X-Staff-Key': key } }).then(r => {
      if (r.status === 401) { location.href = '/staff'; throw new Error('unauthorized'); }
      return r.json();
    }).then(d => { Object.assign(s, d); render(); }).catch(() => {});
  }

  // Whole minutes, "<1" under a minute.
  function dur(ms) {
    if (ms == null || ms < 0) return '–';
    const m = ms / 60000;
    return m < 1 ? '<1' : String(Math.round(m));
  }
  function avg(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; }

  function dayLabel(d) {
    if (d === s.today) return 'Today';
    const t = new Date(s.today + 'T12:00'); t.setDate(t.getDate() - 1);
    if (d === t.toISOString().slice(0, 10)) return 'Yesterday';
    return new Date(d + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function shift(delta) {
    // Step through days that have orders, plus today.
    const days = [...new Set([s.today, ...s.days])].sort();
    const i = days.indexOf(s.day);
    const next = days[i + delta];
    if (next) load(next);
  }

  function render() {
    const days = [...new Set([s.today, ...s.days])].sort();
    const i = days.indexOf(s.day);
    $('prev').disabled = i <= 0;
    $('next').disabled = i >= days.length - 1;
    $('dayLabel').textContent = dayLabel(s.day);

    const o = s.orders;
    const cook = o.filter(x => x.readyAt).map(x => x.readyAt - x.start);
    const pickup = o.filter(x => x.readyAt).map(x => x.collectedAt - x.readyAt);
    $('sCount').textContent = o.length;
    $('sCook').innerHTML = cook.length ? dur(avg(cook)) + '<small>min</small>' : '–';
    $('sPickup').innerHTML = pickup.length ? dur(avg(pickup)) + '<small>min</small>' : '–';
    $('sPhone').innerHTML = o.length ? Math.round(o.filter(x => x.phone).length / o.length * 100) + '<small>%</small>' : '–';
    $('count').textContent = o.length;
    $('empty').hidden = o.length > 0;

    $('list').innerHTML = o.map(x => {
      const cookMs = x.readyAt ? x.readyAt - x.start : null;
      const late = cookMs != null && cookMs > x.eta * 1000;
      return '<div class="row">' +
        '<div class="num">' + x.n + '</div>' +
        '<div class="info"><div class="title">' + W.esc(x.name || 'Walk-in') + '</div>' +
        '<div class="times"><span>Ordered ' + W.hhmm(x.start) + '</span>' +
        (x.readyAt ? '<span>Ready ' + W.hhmm(x.readyAt) + '</span>' : '') +
        '<span>Collected ' + W.hhmm(x.collectedAt) + '</span>' +
        (x.pages > 1 ? '<span>Paged ' + x.pages + '×</span>' : '') + '</div></div>' +
        '<div class="wait' + (late ? ' late' : '') + '">' + (cookMs != null ? dur(cookMs) + ' min' : '–') + '<small>cook time</small></div>' +
        '<span class="tag ' + (x.by === 'phone' ? 'phone' : 'counter') + '"><span class="dot"></span>' +
        (x.by === 'phone' ? 'Confirmed on phone' : 'Marked at counter') + '</span>' +
        '</div>';
    }).join('');
  }

  // Refresh today's list live when an order is collected.
  function connect() {
    es = new EventSource('/api/staff/events' + (key ? '?key=' + encodeURIComponent(key) : ''));
    es.onmessage = e => {
      const d = JSON.parse(e.data);
      if (lastCollected != null && d.collectedToday !== lastCollected && s.day === s.today) load(s.day);
      lastCollected = d.collectedToday;
    };
  }

  $('prev').addEventListener('click', () => shift(-1));
  $('next').addEventListener('click', () => shift(1));
  load().then(connect);
})();
