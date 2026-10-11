// Kitchen Display System: real-time tickets per station with server-clock wait timers.
(function () {
  'use strict';
  const { h, mount, $, api, tr, hhmm, dur } = { ...BF, api: BF.api };
  const app = $('#app');
  const S = { boot: null, tickets: [], station: BF.store.get('kds_station') || 'all', showDone: false, sound: BF.store.get('kds_sound') !== '0', newIds: new Set() };
  const ST = { received: 'รับออเดอร์', sent: 'ส่งเข้าครัว', preparing: 'กำลังเตรียม', cooking: 'กำลังปรุง', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว', cancelled: 'ยกเลิก', unavailable: 'ทำไม่ได้' };
  const NEXT = { received: 'preparing', sent: 'preparing', preparing: 'cooking', cooking: 'ready', ready: 'served' };

  async function start() {
    await BF.requireLogin('Kitchen Display', { permission: 'kitchen.update' });
    try { S.boot = await api.get('/api/kds/bootstrap'); BF.syncClock(S.boot.server_time); } catch (e) { return mount(app, BF.states.error(e, start)); }
    shell(); await load(); connect();
    setInterval(tick, 1000);
  }
  function shell() {
    mount(app,
      h('header.topbar', null,
        h('div.brand', null, '👨‍🍳 Kitchen Display'), h('span.live', null, '● Real-Time'),
        h('nav.tabs.grow', null, [{ id: 'all', name: 'ทุกสถานี' }, ...S.boot.stations].map((s) => h('button.tab', { class: String(S.station) === String(s.id) ? 'active' : '', onclick: () => { S.station = s.id; BF.store.set('kds_station', s.id); shell(); load(); } }, s.name))),
        h('button.btn.sm', { onclick: () => { S.showDone = !S.showDone; shell(); load(); } }, S.showDone ? 'ซ่อนที่เสร็จแล้ว' : 'แสดงที่เสร็จแล้ว'),
        h('button.btn.sm', { onclick: outOfStock }, 'เมนูหมด'),
        h('button.btn.sm', { onclick: () => { S.sound = !S.sound; BF.store.set('kds_sound', S.sound ? '1' : '0'); if (S.sound) BF.beep(880, 120, 1); shell(); } }, S.sound ? '🔔 เสียงเปิด' : '🔕 เสียงปิด'),
        h('button.btn.sm', { onclick: BF.auth.logout }, 'ออก')),
      h('main#board.board'));
    render();
  }
  async function load() {
    try {
      const r = await api.get(`/api/kds/tickets?${S.station !== 'all' ? `station=${S.station}&` : ''}${S.showDone ? 'done=1' : ''}`);
      BF.syncClock(r.server_time); S.tickets = r.tickets; render();
    } catch (e) { mount($('#board'), BF.states.error(e, load)); }
  }
  const reload = BF.debounce(load, 200);
  function connect() {
    const s = BF.socket({ staffToken: BF.auth.token() });
    s.on('connect', () => { s.emit('join', 'kds'); reload(); });
    s.on('kds:new', ({ order }) => {
      if (S.station === 'all' || order.items.some((i) => String(i.station_id) === String(S.station))) {
        order.items.forEach((i) => S.newIds.add(i.ticket_id));
        if (S.sound) BF.beep(1046, 160, 3);
        BF.toast(`ออเดอร์ใหม่ โต๊ะ ${order.table_code} • ${order.order_no}`, 'warn');
      }
      reload();
    });
    s.on('kds:update', reload);
  }
  function waitClass(ms) { const m = ms / 60000; const t = S.boot.thresholds; return m >= t.danger ? 'danger' : m >= t.warn ? 'warn' : 'ok'; }
  function render() {
    const board = $('#board'); if (!board) return;
    const list = S.tickets.slice().sort((a, b) => (b.priority - a.priority) || (a.created_at - b.created_at));
    if (!list.length) return mount(board, BF.states.empty('ไม่มีออเดอร์ค้าง', '✅'));
    mount(board, list.map(ticket));
    tick();
  }
  function ticket(t) {
    const done = ['ready', 'served', 'cancelled', 'unavailable'].includes(t.status);
    const isNew = S.newIds.has(t.id);
    return h('div.ticket', { class: `${t.priority ? 'urgent' : ''} ${done ? 'done' : ''} ${isNew ? 'new' : ''}`, dataset: { since: t.created_at, done: done ? '1' : '' }, onclick: () => { S.newIds.delete(t.id); } },
      h('div.t-head', null,
        h('div', null, h('div.t-table', null, `โต๊ะ ${t.table_code}`), h('div.t-meta', null, `${t.order_no} • ${hhmm(t.created_at)}`, t.station_name ? ` • ${t.station_name}` : '')),
        h('div.t-timer.mono', null, done && t.done_at ? dur(t.done_at - t.created_at) : '')),
      t.is_additional ? h('div.t-flag', null, '＋ รายการเพิ่มเติม') : null,
      h('div.t-items', null, t.items.map((i) => h('button.t-item', { class: `st-${i.status}`, disabled: !NEXT[i.status] || ['cancelled', 'unavailable'].includes(i.status), onclick: (e) => { e.stopPropagation(); setItems([i.id], NEXT[i.status]); } },
        h('div.grow', null, h('div.t-name', null, h('b', null, `${i.qty}×`), ' ', tr(i.name)), i.options.length ? h('div.t-opt', null, i.options.map((o) => `${tr(o.option)}: ${tr(o.choice)}`).join(' • ')) : null, i.note ? h('div.t-note', null, `⚠ ${i.note}`) : null, i.guest_label ? h('div.t-opt', null, `คุณ ${i.guest_label}`) : null),
        h(`span.badge.st.st-${i.status}`, null, ST[i.status])))),
      !done ? h('div.t-actions', null,
        h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); setItems(live(t), 'preparing'); } }, 'รับ/เตรียม'),
        h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); setItems(live(t), 'cooking'); } }, 'กำลังปรุง'),
        h('button.btn.sm.success', { onclick: (e) => { e.stopPropagation(); setItems(live(t), 'ready'); } }, 'พร้อมเสิร์ฟ'),
        h('button.btn.sm.ghost', { title: 'เร่งด่วน', onclick: async (e) => { e.stopPropagation(); try { await api.post(`/api/kds/tickets/${t.id}/priority`, { urgent: !t.priority }); load(); } catch (err) { BF.error(err); } } }, t.priority ? '★' : '☆'),
        h('button.btn.sm.ghost', { title: 'ทำไม่ได้', onclick: (e) => { e.stopPropagation(); unavailable(t); } }, '⛔')) : null);
  }
  const live = (t) => t.items.filter((i) => !['cancelled', 'unavailable', 'ready', 'served'].includes(i.status)).map((i) => i.id);
  async function setItems(ids, status, reason) {
    if (!ids.length) return;
    try { await api.post('/api/kds/items', { item_ids: ids, status, reason }); load(); } catch (e) { BF.error(e); }
  }
  function unavailable(t) {
    const m = BF.modal('รายการที่ไม่สามารถจัดเตรียมได้', h('div.form', null, t.items.filter((i) => !['cancelled', 'unavailable', 'served'].includes(i.status)).map((i) => h('button.btn.block', { onclick: () => { m.close(); setItems([i.id], 'unavailable', 'วัตถุดิบหมด'); } }, `${i.qty}× ${tr(i.name)}`))));
  }
  function tick() {
    const now = BF.now();
    document.querySelectorAll('.ticket').forEach((el) => {
      if (el.dataset.done) return;
      const ms = now - Number(el.dataset.since);
      el.querySelector('.t-timer').textContent = dur(ms);
      el.classList.remove('ok', 'warn', 'danger'); el.classList.add(waitClass(ms));
    });
  }
  async function outOfStock() {
    let items; try { items = (await api.get('/api/admin/menu-items')).items; } catch (e) { return BF.error(e); }
    const body = h('div.oos');
    const draw = () => mount(body, items.filter((i) => i.status !== 'stopped').map((i) => h('label.check.oos-row', null, h('input', { type: 'checkbox', checked: i.status === 'out', onchange: async (e) => {
      const st = e.target.checked ? 'out' : 'available';
      try { await api.patch(`/api/admin/menu-items/${i.id}/status`, { status: st }); i.status = st; BF.toast(`${tr(i.name)}: ${st === 'out' ? 'หมดชั่วคราว' : 'พร้อมขาย'}`, 'success'); } catch (err) { BF.error(err); e.target.checked = !e.target.checked; }
    } }), tr(i.name))));
    BF.modal('ตั้งค่าเมนูหมดชั่วคราว', body);
    draw();
  }
  start();
})();
