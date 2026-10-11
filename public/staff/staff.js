// Staff Call Center: real-time customer requests and dishes ready to serve.
(function () {
  'use strict';
  const { h, mount, $, api, tr, hhmm, dur } = { ...BF, api: BF.api };
  const app = $('#app');
  const S = { calls: [], ready: [], tab: 'calls', sound: BF.store.get('call_sound') !== '0' };
  const CALL_ST = { pending: 'รอรับเรื่อง', accepted: 'รับเรื่องแล้ว', in_progress: 'กำลังดำเนินการ', done: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };

  async function start() {
    await BF.requireLogin('Staff Call Center', { permission: ['call.handle', 'order.create'] });
    shell(); await Promise.all([loadCalls(), loadReady()]); connect();
    setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = dur(BF.now() - Number(el.dataset.since)); }), 1000);
  }
  function shell() {
    const pending = S.calls.filter((c) => c.status === 'pending').length;
    mount(app,
      h('header.topbar', null, h('div.brand', null, '🔔 Staff'),
        h('nav.tabs.grow', null,
          h('button.tab', { class: S.tab === 'calls' ? 'active' : '', onclick: () => { S.tab = 'calls'; shell(); } }, 'เรียกพนักงาน ', pending ? h('span.dot', null, pending) : null),
          h('button.tab', { class: S.tab === 'ready' ? 'active' : '', onclick: () => { S.tab = 'ready'; shell(); } }, 'พร้อมเสิร์ฟ ', S.ready.length ? h('span.dot', { style: { background: 'var(--success)' } }, S.ready.length) : null)),
        h('button.btn.sm', { onclick: () => { S.sound = !S.sound; BF.store.set('call_sound', S.sound ? '1' : '0'); if (S.sound) BF.beep(); shell(); } }, S.sound ? '🔔' : '🔕'),
        h('button.btn.sm', { onclick: BF.auth.logout }, 'ออก')),
      h('main.list', null, S.tab === 'calls' ? callsView() : readyView()));
  }
  function callsView() {
    const open = S.calls.filter((c) => ['pending', 'accepted', 'in_progress'].includes(c.status)).sort((a, b) => a.created_at - b.created_at);
    if (!open.length) return BF.states.empty('ไม่มีคำขอค้าง', '✅');
    const me = BF.auth.staff();
    return open.map((c) => h('div.call', { class: `c-${c.status}` },
      h('div.c-table', null, c.table_code),
      h('div.grow', null, h('div.c-label', null, tr(c.label)), c.note ? h('div', null, c.note) : null,
        h('div.muted.small', null, `${hhmm(c.created_at)} • ${CALL_ST[c.status]}${c.accepted_by_name ? ` • ${c.accepted_by_name}` : ''}${c.guest_label ? ` • คุณ ${c.guest_label}` : ''}`)),
      h('div.c-wait.mono', { dataset: { since: c.created_at } }, dur(BF.now() - c.created_at)),
      h('div.c-actions', null,
        c.status === 'pending' ? h('button.btn.primary', { onclick: () => act(c, 'accepted') }, 'รับงาน') : null,
        c.status === 'accepted' ? h('button.btn', { onclick: () => act(c, 'in_progress') }, 'กำลังทำ') : null,
        h('button.btn.success', { onclick: () => act(c, 'done') }, 'เสร็จ'),
        h('button.btn.ghost', { onclick: () => act(c, 'cancelled') }, 'ยกเลิก'))));
  }
  function readyView() {
    if (!S.ready.length) return BF.states.empty('ยังไม่มีอาหารพร้อมเสิร์ฟ', '🍽️');
    return S.ready.map((i) => h('div.call.c-ready', null,
      h('div.c-table', null, i.table_code),
      h('div.grow', null, h('div.c-label', null, `${i.qty} × ${tr(i.name)}`), i.options.length ? h('div.muted.small', null, i.options.map((o) => tr(o.choice)).join(', ')) : null, h('div.muted.small', null, `${i.order_no}${i.guest_label ? ` • คุณ ${i.guest_label}` : ''}`)),
      h('div.c-wait.mono', { dataset: { since: i.ready_at } }, dur(BF.now() - i.ready_at)),
      h('div.c-actions', null, h('button.btn.success', { onclick: () => served(i) }, 'เสิร์ฟแล้ว'))));
  }
  async function act(c, status) { try { const r = await api.post(`/api/pos/calls/${c.id}`, { status }); upsert(r.call); } catch (e) { BF.error(e); } }
  async function served(i) { try { await api.post('/api/pos/items/status', { item_ids: [i.id], status: 'served' }); S.ready = S.ready.filter((x) => x.id !== i.id); shell(); } catch (e) { BF.error(e); } }
  function upsert(c) { const i = S.calls.findIndex((x) => x.id === c.id); if (i >= 0) S.calls[i] = c; else S.calls.push(c); shell(); }
  async function loadCalls() { try { const r = await api.get('/api/pos/calls'); BF.syncClock(r.server_time); S.calls = r.calls; shell(); } catch (e) { BF.error(e); } }
  async function loadReady() { try { const r = await api.get('/api/pos/ready-items'); S.ready = r.items; shell(); } catch (e) { BF.error(e); } }
  const reloadReady = BF.debounce(loadReady, 300);
  function connect() {
    const s = BF.socket({ staffToken: BF.auth.token() });
    s.on('connect', () => { loadCalls(); loadReady(); });
    s.on('call:new', ({ call }) => { upsert(call); if (S.sound) BF.beep(990, 160, 3); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); BF.toast(`โต๊ะ ${call.table_code}: ${tr(call.label)}`, 'warn', 5000); });
    s.on('call:updated', ({ call }) => upsert(call));
    s.on('calls:changed', () => loadCalls());
    s.on('order:updated', ({ order }) => { if (order.items.some((i) => i.status === 'ready') && S.sound) BF.beep(660, 120, 1); reloadReady(); });
  }
  start();
})();
