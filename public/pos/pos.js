// POS / Cashier / Waiter app: floor plan, open table, session management, ordering for customers, checkout, calls, members, bills, print jobs.
(function () {
  'use strict';
  const { h, mount, $, api, tr, money, baht, hhmm, dt, dur, ikey, toSatang } = { ...BF, api: BF.api };
  const app = $('#app');
  const S = { boot: null, tables: [], zones: [], zone: 'all', view: BF.store.get('pos_view') || 'map', tab: 'tables', calls: [], panel: null, socket: null };
  const can = (p) => BF.auth.can(p);

  const STATUS = {
    available: ['ว่าง', '#16a34a'], occupied: ['มีลูกค้า', '#2563eb'], dining: ['กำลังรับประทาน', '#7c3aed'], near_end: ['ใกล้หมดเวลา', '#f59e0b'], time_up: ['หมดเวลา', '#dc2626'],
    payment_pending: ['รอชำระเงิน', '#db2777'], paid: ['ชำระเงินแล้ว', '#0f766e'], cleaning: ['รอทำความสะอาด', '#64748b'], disabled: ['ปิดใช้งาน', '#9ca3af'], reserved: ['จองล่วงหน้า', '#0891b2'],
  };
  const ITEM_ST = { received: 'รับออเดอร์แล้ว', sent: 'ส่งเข้าครัว', preparing: 'กำลังเตรียม', cooking: 'กำลังปรุง', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว', cancelled: 'ยกเลิก', unavailable: 'ไม่สามารถจัดเตรียมได้' };
  const CALL_ST = { pending: 'รอรับเรื่อง', accepted: 'รับเรื่องแล้ว', in_progress: 'กำลังดำเนินการ', done: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };
  const JOB_ST = { pending: 'รอพิมพ์', printing: 'กำลังพิมพ์', printed: 'พิมพ์แล้ว', failed: 'ล้มเหลว' };

  async function start() {
    await BF.requireLogin('POS • แคชเชียร์', { permission: ['table.open', 'table.close', 'order.create', 'call.handle'] });
    try { S.boot = await api.get('/api/pos/bootstrap'); } catch (e) { return mount(app, BF.states.error(e, start)); }
    BF.syncClock(S.boot.server_time);
    S.tables = S.boot.tables; S.zones = S.boot.zones;
    shell();
    connect();
    loadCalls();
    setInterval(tickTimers, 1000);
  }

  function shell() {
    const st = BF.auth.staff();
    mount(app,
      h('header.topbar', null,
        h('div.brand', null, '🍽 POS'),
        S.boot.branches.length > 1 ? h('select', { onchange: (e) => switchBranch(e.target.value) }, S.boot.branches.map((b) => h('option', { value: b.id, selected: b.id === S.boot.branch.id }, `${b.code}`))) : h('span.hide-sm', null, tr(S.boot.branch.name)),
        h('nav.tabs.grow', null,
          tabBtn('tables', 'ผังโต๊ะ'), tabBtn('calls', 'เรียกพนักงาน', h('span.dot.hidden#calldot')), tabBtn('bills', 'บิล / คืนเงิน'), tabBtn('members', 'สมาชิก'), tabBtn('prints', 'งานพิมพ์')),
        h('span.hide-sm', null, st.name),
        h('button.btn.sm', { onclick: BF.auth.logout }, 'ออก')),
      h('main#main.pos-main'));
    renderTab();
  }
  function tabBtn(id, label, extra) { return h('button.tab', { class: S.tab === id ? 'active' : '', onclick: () => { S.tab = id; shell(); } }, label, extra ? ' ' : null, extra); }
  async function switchBranch(id) { try { const r = await api.post('/api/auth/switch-branch', { branch_id: Number(id) }); BF.auth.set(r.token, r.staff, r.branch_id); location.reload(); } catch (e) { BF.error(e); } }

  function renderTab() {
    const main = $('#main');
    if (S.tab === 'tables') return renderFloor(main);
    if (S.tab === 'calls') return renderCalls(main);
    if (S.tab === 'bills') return renderBills(main);
    if (S.tab === 'members') return renderMembers(main);
    if (S.tab === 'prints') return renderPrints(main);
  }

  // ---------- realtime ----------
  function connect() {
    S.socket = BF.socket({ staffToken: BF.auth.token() });
    const refresh = BF.debounce(refreshTables, 250);
    S.socket.on('tables:changed', (p) => { refresh(); if (S.panel && p.session_id === S.panel.id) refreshPanel(); });
    S.socket.on('order:new', ({ order }) => { if (S.panel && order.session_id === S.panel.id) refreshPanel(); refresh(); });
    S.socket.on('order:updated', ({ order }) => { if (S.panel && order.session_id === S.panel.id) refreshPanel(); });
    S.socket.on('call:new', ({ call }) => { upsertCall(call); BF.toast(`🔔 โต๊ะ ${call.table_code}: ${tr(call.label)}`, 'warn', 5000); BF.beep(990, 150, 3); });
    S.socket.on('call:updated', ({ call }) => upsertCall(call));
    S.socket.on('session:alert', (a) => { if (a.kind === 'time_up') BF.toast(`⏰ โต๊ะ ${a.table_code} หมดเวลา`, 'error', 6000); else if (a.kind === 'time_left') BF.toast(`โต๊ะ ${a.table_code} เหลือเวลา ${a.minutes} นาที`, 'warn'); refresh(); });
    S.socket.on('print:job', ({ job }) => {
      if (job.status === 'failed') BF.toast(`พิมพ์ไม่สำเร็จ: ${job.doc_label} — ${job.error || ''}`, 'error', 6000);
      if (S.tab === 'prints') renderTab();
      if (S.panel) refreshPanelPrints(job);
    });
    S.socket.on('bill:updated', () => { if (S.tab === 'bills') renderTab(); });
    S.socket.on('connect', () => refresh());
  }
  async function refreshTables() {
    try { const r = await api.get('/api/pos/tables'); S.tables = r.tables; S.zones = r.zones; BF.syncClock(r.server_time); if (S.tab === 'tables') renderFloor($('#main')); } catch (e) { /* offline */ }
  }

  // ---------- floor ----------
  function renderFloor(main) {
    const counts = {};
    for (const t of S.tables) counts[t.display_status] = (counts[t.display_status] || 0) + 1;
    const zones = [{ id: 'all', name: 'ทั้งหมด' }, ...S.zones];
    const list = S.tables.filter((t) => S.zone === 'all' || t.zone_id === Number(S.zone));
    mount(main,
      h('div.floor-bar', null,
        h('div.row', null, zones.map((z) => h('button.chip', { class: String(S.zone) === String(z.id) ? 'active' : '', onclick: () => { S.zone = z.id; renderFloor(main); } }, z.name))),
        h('div.row', null,
          h('button.chip', { class: S.view === 'map' ? 'active' : '', onclick: () => { S.view = 'map'; BF.store.set('pos_view', 'map'); renderFloor(main); } }, '🗺 ผัง'),
          h('button.chip', { class: S.view === 'grid' ? 'active' : '', onclick: () => { S.view = 'grid'; BF.store.set('pos_view', 'grid'); renderFloor(main); } }, '▦ ตาราง'))),
      h('div.legend', null, Object.entries(STATUS).map(([k, [l, c]]) => h('span.legend-item', null, h('i', { style: { background: c } }), `${l} ${counts[k] ? `(${counts[k]})` : ''}`))),
      !S.tables.length ? BF.states.empty('ยังไม่มีโต๊ะ — เพิ่มโต๊ะได้ที่หน้า Admin › ผังร้าน', '🪑') :
        S.view === 'grid'
          ? h('div.table-grid', null, list.map(tableCard))
          : floorMap(list));
  }
  function floorMap(list) {
    const groups = S.zone === 'all' ? S.zones.map((z) => ({ z, items: list.filter((t) => t.zone_id === z.id) })).concat([{ z: { name: 'ไม่ระบุโซน' }, items: list.filter((t) => !t.zone_id) }]).filter((g) => g.items.length) : [{ z: S.zones.find((z) => z.id === Number(S.zone)) || {}, items: list }];
    return h('div', null, groups.map(({ z, items }) => {
      const w = Math.max(z.width || 0, ...items.map((t) => t.x + t.w + 20)), hgt = Math.max(...items.map((t) => t.y + t.h + 20), 200);
      return h('div.zone-block', null, h('h3', null, z.name),
        h('div.floor-scroll', null, h('div.floor', { style: { width: `${w}px`, height: `${hgt}px` } }, items.map((t) => {
          const el = tableCard(t);
          Object.assign(el.style, { position: 'absolute', left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px`, transform: t.rotation ? `rotate(${t.rotation}deg)` : '' });
          return el;
        }))));
    }));
  }
  function tableCard(t) {
    const [label, color] = STATUS[t.display_status] || [t.display_status, '#999'];
    const s = t.session;
    return h(`button.tcard.${t.shape}`, { style: { '--c': color }, onclick: () => onTable(t), dataset: { tid: t.id } },
      h('div.tcode', null, t.code),
      s ? h('div.tsub', null, `👤${s.guests_count}`, s.pending_calls ? h('span.call-badge', null, `🔔${s.pending_calls}`) : null) : h('div.tsub', null, `${t.seats} ที่นั่ง`),
      s ? h('div.ttime.mono', { dataset: { end: s.end_at } }, '') : h('div.tlabel', null, label),
      t.status === 'reserved' && t.reserved_note ? h('div.tlabel', null, t.reserved_note) : null);
  }
  function tickTimers() {
    const now = BF.now();
    document.querySelectorAll('.ttime[data-end]').forEach((el) => { const left = Number(el.dataset.end) - now; el.textContent = left > 0 ? dur(left) : `+${dur(-left)}`; el.classList.toggle('over', left <= 0); });
    document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = dur(now - Number(el.dataset.since)); });
    const p = $('#panel-left'); if (p && S.panel) { const left = S.panel.end_at - now; p.textContent = left > 0 ? `เหลือ ${dur(left)}` : `เกินเวลา ${dur(-left)}`; p.classList.toggle('over', left <= 0); }
  }

  function onTable(t) {
    if (t.session) return openPanel(t.session.id);
    if (['cleaning', 'disabled', 'reserved'].includes(t.status) && !t.session) {
      const m = BF.modal(`โต๊ะ ${t.code} • ${STATUS[t.display_status][0]}`, h('div.form', null,
        t.status !== 'disabled' ? h('button.btn.primary.block', { onclick: () => { m.close(); if (t.status === 'reserved') return openTableDialog(t, true); setStatus(t, 'available'); } }, t.status === 'reserved' ? 'เปิดโต๊ะสำหรับลูกค้าที่จอง' : '✔ ทำความสะอาดแล้ว (ว่าง)') : null,
        h('button.btn.block', { onclick: () => { m.close(); setStatus(t, 'available'); } }, 'ตั้งเป็นว่าง'),
        t.status !== 'disabled' ? h('button.btn.block', { onclick: () => { m.close(); setStatus(t, 'disabled'); } }, 'ปิดใช้งานโต๊ะ') : null));
      return;
    }
    openTableDialog(t);
  }
  async function setStatus(t, status, note) {
    try { await api.post(`/api/pos/tables/${t.id}/status`, { status, note }); refreshTables(); } catch (e) { BF.error(e); }
  }

  // ---------- open table ----------
  function openTableDialog(t, force) {
    if (!can('table.open')) return BF.toast('ไม่มีสิทธิ์เปิดโต๊ะ', 'error');
    const pkgs = S.boot.packages.filter((p) => p.active);
    if (!pkgs.length) return BF.toast('ยังไม่มีแพ็กเกจ — เพิ่มที่หน้า Admin', 'error');
    const st = { counts: {}, member: null, contact: '', duration: '', printSlip: true, start: '' };
    const allowMixed = S.boot.settings.allow_mixed_packages;
    let activePkg = pkgs.find((p) => p.sellable) || pkgs[0];
    const summary = h('div.open-summary');
    const pkgArea = h('div');
    const total = () => Object.entries(st.counts).reduce((a, [k, n]) => { const [pid, code] = k.split('|'); const p = pkgs.find((x) => x.id === Number(pid)); const pr = p && p.prices.find((x) => x.code === code); return a + (pr ? pr.price * n : 0); }, 0);
    const guests = () => Object.values(st.counts).reduce((a, b) => a + b, 0);
    const drawPkgs = () => mount(pkgArea,
      h('div.pkg-tabs', null, pkgs.map((p) => h('button.pkg-tab', { class: p.id === activePkg.id ? 'active' : '', style: { '--pc': p.color }, disabled: !p.sellable, title: p.unavailable_reason || '', onclick: () => { if (!allowMixed) st.counts = {}; activePkg = p; drawPkgs(); drawSummary(); } },
        h('b', null, tr(p.name)), h('div.small', null, p.sellable ? `${p.duration_min} นาที` : p.unavailable_reason)))),
      h('div.price-rows', null, activePkg.prices.map((pr) => {
        const k = `${activePkg.id}|${pr.code}`; const n = st.counts[k] || 0;
        return h('div.price-row', null, h('div.grow', null, h('b', null, tr(pr.label)), h('div.muted.small', null, `${baht(pr.price)} / ท่าน${pr.rule_type === 'age' ? ` • อายุ ${pr.min_value ?? 0}${pr.max_value != null ? `-${pr.max_value}` : '+'} ปี` : pr.rule_type === 'height' ? ` • สูง ${pr.min_value ?? 0}-${pr.max_value ?? '∞'} ซม.` : ''}`)),
          h('div.stepper.lg', null, h('button', { onclick: () => { st.counts[k] = Math.max(0, n - 1); if (!st.counts[k]) delete st.counts[k]; drawPkgs(); drawSummary(); } }, '−'), h('span', null, n), h('button', { onclick: () => { st.counts[k] = n + 1; drawPkgs(); drawSummary(); } }, '+')));
      })));
    const drawSummary = () => {
      const s = S.boot.settings; const sub = total();
      const sc = Math.round(sub * s.service_rate / 100); const vat = s.prices_include_vat ? Math.round((sub + sc) * s.vat_rate / (100 + s.vat_rate)) : Math.round((sub + sc) * s.vat_rate / 100);
      const dmin = Number(st.duration) || Math.max(...Object.keys(st.counts).map((k) => (pkgs.find((p) => p.id === Number(k.split('|')[0])) || {}).duration_min || 0), activePkg.duration_min);
      const startTs = st.start ? toTodayTs(st.start) : BF.now();
      mount(summary,
        h('div.sum-row', null, h('span', null, 'จำนวนลูกค้า'), h('b', null, `${guests()} ท่าน`)),
        h('div.sum-row', null, h('span', null, 'เวลา'), h('b', null, `${hhmm(startTs)} - ${hhmm(startTs + dmin * 60000)} (${dmin} นาที)`)),
        h('div.sum-row', null, h('span', null, 'ค่าอาหาร'), h('span', null, money(sub))),
        sc ? h('div.sum-row', null, h('span', null, `Service ${s.service_rate}%`), h('span', null, money(sc))) : null,
        h('div.sum-row', null, h('span', null, `VAT ${s.vat_rate}%${s.prices_include_vat ? ' (รวมใน)' : ''}`), h('span', null, money(vat))),
        h('div.sum-row.total', null, h('span', null, 'ยอดเบื้องต้น'), h('span', null, baht(s.prices_include_vat ? sub + sc : sub + sc + vat))));
      okBtn.disabled = !guests();
    };
    const memberBox = h('div');
    const drawMember = () => mount(memberBox, st.member
      ? h('div.member-chip', null, h('b', null, `${st.member.first_name || ''} ${st.member.last_name || ''}`), h('span.muted', null, ` ${st.member.code} • ${st.member.points} pts`), h('button.btn.sm.ghost', { onclick: () => { st.member = null; drawMember(); } }, '✕'))
      : h('div.row', null, h('button.btn.sm', { onclick: () => memberPicker((m) => { st.member = m; drawMember(); }) }, '🔍 ค้นหาสมาชิก'), h('span.muted.small', null, 'ไม่เป็นสมาชิก (จะพิมพ์ใบสมัครสมาชิกตามการตั้งค่า)')));
    const okBtn = h('button.btn.primary', { onclick: submit }, 'เปิดโต๊ะ & พิมพ์ QR');
    const content = h('div.open-grid', null,
      h('div', null, h('h4', null, 'แพ็กเกจและจำนวนลูกค้า'), pkgArea),
      h('div.form', null,
        h('h4', null, 'ข้อมูลเพิ่มเติม'),
        h('label', null, 'สมาชิก', memberBox),
        h('label', null, 'ชื่อผู้ติดต่อ (ไม่บังคับ)', h('input', { placeholder: 'เช่น คุณ A', oninput: (e) => { st.contact = e.target.value; } })),
        h('div.form-grid', null,
          h('label', null, 'เวลาเริ่ม', h('input', { type: 'time', oninput: (e) => { st.start = e.target.value; drawSummary(); } })),
          h('label', null, 'ระยะเวลา (นาที)', h('input', { type: 'number', min: 15, step: 15, placeholder: 'ตามแพ็กเกจ', oninput: (e) => { st.duration = e.target.value; drawSummary(); } }))),
        h('label.check', null, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.printSlip = e.target.checked; } }), 'พิมพ์ใบสมัครสมาชิก (ถ้าไม่เป็นสมาชิก)'),
        summary));
    const m = BF.modal(`เปิดโต๊ะ ${t.code}`, content, { wide: true, actions: [h('button.btn', { onclick: () => m.close() }, 'ยกเลิก'), okBtn] });
    drawPkgs(); drawMember(); drawSummary();
    async function submit() {
      okBtn.disabled = true;
      try {
        const groups = Object.entries(st.counts).map(([k, count]) => { const [package_id, price_code] = k.split('|'); return { package_id: Number(package_id), price_code, count }; });
        const r = await api.post('/api/pos/sessions', { table_id: t.id, groups, member_id: st.member ? st.member.id : undefined, contact_name: st.contact || undefined, duration_min: st.duration ? Number(st.duration) : undefined, start_at: st.start ? toTodayTs(st.start) : undefined, print_member_slip: st.printSlip, force });
        m.close();
        BF.toast(`เปิดโต๊ะ ${t.code} • #${r.public_code}`, 'success');
        if (!r.print_jobs.length) BF.toast('ยังไม่ได้กำหนดเครื่องพิมพ์สำหรับใบ QR — แสดง QR บนหน้าจอแทน', 'warn', 5000);
        refreshTables();
        openPanel(r.id, { showQr: !r.print_jobs.length });
      } catch (e) { BF.error(e); okBtn.disabled = false; }
    }
  }
  function toTodayTs(hm) { const [hh, mm] = hm.split(':').map(Number); const d = new Date(BF.now()); d.setHours(hh, mm, 0, 0); return d.getTime(); }

  function memberPicker(onPick, { allowCreate = true, sessionId } = {}) {
    const results = h('div.member-results');
    const q = h('input', { placeholder: 'เบอร์โทร / รหัสสมาชิก / ชื่อ / สแกนบาร์โค้ด', autofocus: true, oninput: BF.debounce(search, 300), onkeydown: (e) => { if (e.key === 'Enter') search(); } });
    async function search() {
      if (q.value.trim().length < 2) return mount(results);
      try {
        const r = await api.get(`/api/pos/members?q=${encodeURIComponent(q.value.trim())}`);
        mount(results, r.members.length ? r.members.map((mm) => h('button.list-btn', { onclick: () => { m.close(); onPick(mm); } }, h('b', null, `${mm.first_name || ''} ${mm.last_name || ''}`), h('span.muted', null, ` ${mm.code} • ${mm.phone} • ${mm.points} pts ${mm.tier ? '• ' + tr(mm.tier.name) : ''}`))) : h('div.muted', null, 'ไม่พบสมาชิก'));
      } catch (e) { BF.error(e); }
    }
    const m = BF.modal('ค้นหาสมาชิก', h('div.form', null, q, results, allowCreate && can('member.manage') ? h('button.btn', { onclick: () => { m.close(); registerMember((mm) => onPick(mm), sessionId); } }, '+ สมัครสมาชิกใหม่ที่เคาน์เตอร์') : null));
  }
  function registerMember(onDone, sessionId) {
    const f = { phone: h('input', { type: 'tel' }), first_name: h('input'), last_name: h('input'), birthday: h('input', { type: 'date' }), email: h('input', { type: 'email' }) };
    const consent = h('input', { type: 'checkbox' });
    const m = BF.modal('สมัครสมาชิก', h('div.form', null, Object.entries({ phone: 'เบอร์โทรศัพท์ *', first_name: 'ชื่อ *', last_name: 'นามสกุล', birthday: 'วันเกิด', email: 'อีเมล' }).map(([k, l]) => h('label', null, l, f[k])), h('label.check', null, consent, 'ลูกค้ายินยอมตามนโยบายความเป็นส่วนตัว (PDPA)')), {
      actions: [h('button.btn', { onclick: () => m.close() }, 'ยกเลิก'), h('button.btn.primary', { onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await api.post('/api/pos/members', { phone: f.phone.value, first_name: f.first_name.value, last_name: f.last_name.value, birthday: f.birthday.value || undefined, email: f.email.value || undefined, consent: consent.checked, session_id: sessionId }); m.close(); BF.toast('สมัครสมาชิกสำเร็จ', 'success'); onDone(r.member); } catch (err) { BF.error(err); e.target.disabled = false; }
      } }, 'บันทึก')] });
  }

  // ---------- session panel ----------
  let panelModal = null, panelTab = 'orders';
  async function openPanel(id, opts = {}) {
    if (panelModal) panelModal.close();
    const body = h('div.panel', null, BF.states.loading(3, 'sk-line'));
    panelModal = BF.modal('', body, { wide: true, onClose: () => { S.panel = null; panelModal = null; } });
    panelModal.el.classList.add('panel-modal');
    await loadPanel(id);
    if (opts.showQr) showQr();
  }
  async function loadPanel(id) {
    try { S.panel = await api.get(`/api/pos/sessions/${id}`); drawPanel(); } catch (e) { if (panelModal) mount(panelModal.body, BF.states.error(e, () => loadPanel(id))); }
  }
  const refreshPanel = BF.debounce(() => { if (S.panel) loadPanel(S.panel.id); }, 300);
  function refreshPanelPrints(job) { if (!S.panel) return; const i = (S.panel.print_jobs || []).findIndex((j) => j.id === job.id); if (i >= 0) { S.panel.print_jobs[i] = job; if (panelTab === 'prints') drawPanel(); } }

  function drawPanel() {
    const p = S.panel; if (!p || !panelModal) return;
    const active = ['active', 'billing'].includes(p.status);
    const title = panelModal.el.querySelector('.modal-title');
    if (title) mount(title, `โต๊ะ ${p.table.code} `, h('span.muted.small', null, `#${p.public_code}`), ' ', h('span.badge', { style: { background: (STATUS[p.display_status] || [])[1], color: '#fff' } }, (STATUS[p.display_status] || [p.status])[0]));
    const b = p.bill;
    const actions = active ? [
      can('table.qr') && h('button.btn.sm', { onclick: () => printDoc('qr_ticket') }, '🖨 พิมพ์ QR'),
      can('table.qr') && h('button.btn.sm', { onclick: showQr }, '▣ แสดง QR'),
      can('table.qr') && h('button.btn.sm', { onclick: regenQr }, '↻ QR ใหม่'),
      can('order.create') && p.status === 'active' && h('button.btn.sm', { onclick: staffOrder }, '＋ สั่งอาหาร'),
      can('table.extend') && h('button.btn.sm', { onclick: extend }, '⏱ ต่อเวลา'),
      can('table.move') && h('button.btn.sm', { onclick: moveTable }, '⇄ ย้ายโต๊ะ'),
      can('table.move') && h('button.btn.sm', { onclick: mergeTable }, '⊕ รวมโต๊ะ'),
      can('table.move') && p.guests_count > 1 && h('button.btn.sm', { onclick: splitTable }, '⊘ แยกโต๊ะ'),
      can('table.package') && h('button.btn.sm', { onclick: editGuests }, '👥 ลูกค้า/แพ็กเกจ'),
      (can('member.manage') || can('table.open')) && h('button.btn.sm', { onclick: linkMember }, p.member ? '👤 เปลี่ยนสมาชิก' : '👤 ผูกสมาชิก'),
      can('discount.apply') && h('button.btn.sm', { onclick: discountDialog }, '％ ส่วนลด/โปรโมชั่น'),
      can('table.close') && h('button.btn.sm', { onclick: adjustDialog }, '± ค่าปรับ/รายการเพิ่ม'),
    ] : [];
    mount(panelModal.body,
      h('div.panel-head', null,
        h('div.kv', null,
          h('span', null, 'เวลา'), h('b', null, `${hhmm(p.start_at)} - ${hhmm(p.end_at)} (${p.duration_min} นาที)`),
          h('span', null, 'คงเหลือ'), h('b#panel-left.mono', null, ''),
          p.order_end_at < p.end_at ? h('span', null, 'ปิดรับออเดอร์') : null, p.order_end_at < p.end_at ? h('b', null, hhmm(p.order_end_at)) : null,
          h('span', null, 'ลูกค้า'), h('b', null, `${p.guests_count} ท่าน${p.contact_name ? ` • ${p.contact_name}` : ''}`),
          h('span', null, 'แพ็กเกจ'), h('div', null, groupGuests(p.guests).map((g) => h('div', null, `${tr(g.package_name)} — ${tr(g.price_label) || g.price_code} × ${g.n} (${baht(g.unit_price)})`))),
          h('span', null, 'สมาชิก'), h('b', null, p.member ? `${p.member.first_name || ''} ${p.member.code} • ${p.member.points} pts` : '— ไม่เป็นสมาชิก')),
        b ? h('div.panel-total', null, h('div.muted', null, 'ยอดปัจจุบัน'), h('div.big', null, baht(b.total)), h('div.muted.small', null, `อาหารเพิ่ม ${money(b.extras_total)} • ส่วนลด ${money(b.discount_total)}`)) : null),
      h('div.action-bar', null, actions.filter(Boolean)),
      h('div.row.ptabs', null, ['orders', 'bill', 'calls', 'prints'].map((k) => h('button.chip', { class: panelTab === k ? 'active' : '', onclick: () => { panelTab = k; drawPanel(); } }, { orders: `ออเดอร์ (${p.orders.length})`, bill: 'บิล', calls: `เรียกพนักงาน (${p.calls.filter((c) => ['pending', 'accepted', 'in_progress'].includes(c.status)).length})`, prints: 'งานพิมพ์' }[k]))),
      h('div.ptab-body', null, panelTab === 'orders' ? ordersView(p) : panelTab === 'bill' ? billView(p) : panelTab === 'calls' ? callsView(p.calls) : printsView(p.print_jobs)),
      active && can('table.close') ? h('div.checkout-bar', null,
        p.status === 'billing' ? h('button.btn', { onclick: cancelCheckout }, 'ยกเลิกการคิดเงิน') : null,
        h('button.btn.primary.lg', { onclick: checkout }, p.status === 'billing' ? '💳 รับชำระเงิน' : '💳 คิดเงิน / ปิดโต๊ะ')) : null);
    tickTimers();
  }
  function groupGuests(gs) { const m = new Map(); for (const g of gs) { const k = `${g.package_id}|${g.price_code}|${g.unit_price}`; if (!m.has(k)) m.set(k, { ...g, n: 0 }); m.get(k).n++; } return [...m.values()]; }

  function ordersView(p) {
    if (!p.orders.length) return BF.states.empty('ยังไม่มีออเดอร์', '🧾');
    return h('div.orders', null, p.orders.map((o) => h('div.order-box', null,
      h('div.row.between', null, h('b', null, `#${o.order_no}`), h('span.muted.small', null, `${hhmm(o.created_at)} • ${o.source === 'staff' ? 'พนักงาน' : 'ลูกค้า'}${o.guest_label ? ` • คุณ ${o.guest_label}` : ''}`)),
      o.items.map((i) => h('div.item-line', null,
        h('div.grow', null, h('div', null, `${i.qty} × ${tr(i.name)}`, i.unit_extra ? h('span.muted', null, ` (+${money(i.unit_extra * i.qty)})`) : null), i.options.length ? h('div.muted.small', null, i.options.map((x) => tr(x.choice)).join(', ')) : null, i.note ? h('div.muted.small', null, `“${i.note}”`) : null, i.cancel_reason ? h('div.small', { style: { color: 'var(--danger)' } }, i.cancel_reason) : null),
        h(`span.badge.st.st-${i.status}`, null, ITEM_ST[i.status]),
        ['ready', 'sent', 'preparing', 'cooking'].includes(i.status) && can('order.create') ? h('button.btn.sm', { onclick: () => itemStatus([i.id], 'served') }, 'เสิร์ฟแล้ว') : null,
        !['cancelled', 'unavailable'].includes(i.status) && can('order.cancel') ? h('button.btn.sm.ghost', { title: 'ยกเลิก', onclick: () => cancelItem(i) }, '✕') : null)))));
  }
  async function itemStatus(ids, status, reason) {
    try { await BF.withApproval((approval) => api.post('/api/pos/items/status', { item_ids: ids, status, reason, approval }), 'ยกเลิกรายการที่เสิร์ฟแล้วต้องได้รับอนุมัติ'); refreshPanel(); } catch (e) { BF.error(e); }
  }
  function cancelItem(i) {
    const reason = prompt(`เหตุผลการยกเลิก "${tr(i.name)}"`); if (reason == null) return;
    itemStatus([i.id], 'cancelled', reason || 'ยกเลิกโดยพนักงาน');
  }

  function billView(p) {
    const b = p.bill;
    const out = [];
    if (b) out.push(h('div.bill', null,
      b.lines.map((l) => h('div.sum-row', null, h('span', null, `${l.qty} × ${l.name}`), h('span', null, money(l.amount)))),
      b.discounts.map((d) => h('div.sum-row', { style: { color: d.amount ? 'var(--success)' : 'var(--muted)' } }, h('span', null, `${d.name}${d.skipped ? ` (${d.skipped})` : ''}`), h('span', null, d.amount ? `-${money(d.amount)}` : '—'))),
      h('div.sum-row', null, h('span', null, 'SubTotal'), h('span', null, money(b.subtotal))),
      h('div.sum-row', null, h('span', null, `Service Charge (${b.service_rate}%)`), h('span', null, money(b.service_charge))),
      h('div.sum-row', null, h('span', null, `VAT (${b.vat_rate}%)${b.prices_include_vat ? ' รวมใน' : ''}`), h('span', null, money(b.vat))),
      h('div.sum-row.total', null, h('span', null, 'Total'), h('span', null, money(b.total)))));
    if (p.redemptions.length) out.push(h('h4', null, 'โปรโมชั่นที่ใช้'), p.redemptions.map((r) => h('div.row.between', null, h('span', null, `${tr(r.name)} (${r.code})`), h('span', null, h('span.badge', null, r.status), r.status === 'applied' && can('discount.apply') ? h('button.btn.sm.ghost', { onclick: async () => { try { await api.del(`/api/pos/sessions/${p.id}/promo/${r.id}`); refreshPanel(); } catch (e) { BF.error(e); } } }, 'นำออก') : null))));
    if (p.adjustments.length) out.push(h('h4', null, 'รายการปรับ'), p.adjustments.map((a, i) => h('div.row.between', null, h('span', null, a.code === 'waive_overtime' ? 'ยกเว้นค่าปรับเกินเวลา' : `${a.label} ${money(a.amount)}`), a.code !== 'waive_overtime' ? h('button.btn.sm.ghost', { onclick: async () => { try { await api.post(`/api/pos/sessions/${p.id}/adjustments`, { remove: i }); refreshPanel(); } catch (e) { BF.error(e); } } }, 'ลบ') : null)));
    if (p.bills.length) out.push(h('h4', null, 'บิล'), p.bills.map((x) => h('div.row.between', null, h('span', null, `${x.bill_no}${x.split_label ? ` (${x.split_label})` : ''}`), h('span', null, `${money(x.paid_total)} / ${money(x.total)} `, h('span.badge', null, x.status)))));
    return h('div', null, out);
  }
  function callsView(calls) {
    if (!calls.length) return BF.states.empty('ไม่มีคำขอ', '🔔');
    return h('div', null, calls.map((c) => callRow(c)));
  }
  function printsView(jobs) {
    if (!jobs || !jobs.length) return BF.states.empty('ยังไม่มีงานพิมพ์', '🖨');
    return h('div', null, jobs.map((j) => h('div.row.between.line', null, h('span', null, `${j.doc_label} • ${hhmm(j.created_at)}`), h('span', null, h(`span.badge.st.st-${j.status}`, null, JOB_ST[j.status]), j.error ? h('span.small.muted', null, ` ${j.error}`) : null, ['failed', 'printed'].includes(j.status) ? h('button.btn.sm.ghost', { onclick: () => retryJob(j.id) }, 'พิมพ์ซ้ำ') : null))));
  }
  async function retryJob(id) { try { await api.post(`/api/pos/print-jobs/${id}/retry`); BF.toast('ส่งงานพิมพ์อีกครั้ง', 'success'); } catch (e) { BF.error(e); } }

  async function printDoc(doc) {
    try { const r = await api.post(`/api/pos/sessions/${S.panel.id}/print`, { doc }); BF.toast(`ส่งพิมพ์แล้ว (${r.jobs.length})`, 'success'); refreshPanel(); } catch (e) { BF.error(e); if (e.code === 'no_printer' && doc === 'qr_ticket') showQr(); }
  }
  function showQr() {
    const p = S.panel;
    if (!p.order_url) return BF.toast('ไม่มีสิทธิ์ดู QR', 'error');
    BF.modal(`QR สั่งอาหาร • โต๊ะ ${p.table.code}`, h('div.center', null,
      qrImg(`/api/pos/sessions/${p.id}/qr.png?v=${p.token_version}`),
      h('p.muted', null, 'ให้ลูกค้าสแกนเพื่อสั่งอาหาร • QR ใช้ได้เฉพาะรอบนี้ และสิ้นสุดทันทีเมื่อปิดโต๊ะ'),
      h('div.small.mono', { style: { wordBreak: 'break-all' } }, p.order_url)));
  }
  // images behind staff auth are fetched with the bearer token and shown as blob URLs
  function qrImg(url) {
    const img = h('img.qr-big', { alt: 'QR' });
    api.raw('GET', url, undefined, { raw: true }).then((blob) => { img.src = URL.createObjectURL(blob); }).catch((e) => BF.error(e));
    return img;
  }
  async function regenQr() {
    if (!await BF.confirm('สร้าง QR ใหม่? QR เดิมจะใช้งานไม่ได้ทันที และลูกค้าต้องสแกน QR ใหม่', { danger: true, ok: 'สร้าง QR ใหม่' })) return;
    try { await api.post(`/api/pos/sessions/${S.panel.id}/qr/regenerate`); BF.toast('สร้าง QR ใหม่แล้ว', 'success'); await loadPanel(S.panel.id); } catch (e) { BF.error(e); }
  }
  async function extend() {
    const m = BF.modal('ต่อเวลา', h('div.row', null, [15, 30, 45, 60].map((n) => h('button.btn', { onclick: async () => { m.close(); try { await api.post(`/api/pos/sessions/${S.panel.id}/extend`, { minutes: n }); BF.toast(`ต่อเวลา ${n} นาที`, 'success'); loadPanel(S.panel.id); refreshTables(); } catch (e) { BF.error(e); } } }, `+${n} นาที`))));
  }
  function tablePicker(title, filter, onPick) {
    const list = S.tables.filter(filter);
    const m = BF.modal(title, list.length ? h('div.table-grid.small', null, list.map((t) => { const c = tableCard(t); c.onclick = () => { m.close(); onPick(t); }; return c; })) : BF.states.empty('ไม่มีโต๊ะที่เลือกได้'), { wide: true });
  }
  function moveTable() {
    tablePicker('ย้ายไปโต๊ะ', (t) => !t.session && ['available', 'reserved'].includes(t.status), async (t) => {
      try { await api.post(`/api/pos/sessions/${S.panel.id}/move`, { table_id: t.id }); BF.toast(`ย้ายไปโต๊ะ ${t.code}`, 'success'); loadPanel(S.panel.id); refreshTables(); } catch (e) { BF.error(e); }
    });
  }
  function mergeTable() {
    tablePicker('เลือกโต๊ะที่จะรวมเข้ามาในโต๊ะนี้', (t) => t.session && t.session.id !== S.panel.id, async (t) => {
      if (!await BF.confirm(`รวมโต๊ะ ${t.code} เข้ากับโต๊ะ ${S.panel.table.code}? ออเดอร์และลูกค้าจะย้ายมาที่โต๊ะนี้`)) return;
      try { await api.post(`/api/pos/sessions/${S.panel.id}/merge`, { from_session_id: t.session.id }); BF.toast('รวมโต๊ะแล้ว', 'success'); loadPanel(S.panel.id); refreshTables(); } catch (e) { BF.error(e); }
    });
  }
  function splitTable() {
    const sel = new Set();
    const m = BF.modal('แยกโต๊ะ — เลือกลูกค้าที่ย้ายไปโต๊ะใหม่', h('div.form', null, S.panel.guests.map((g) => h('label.check', null, h('input', { type: 'checkbox', onchange: (e) => (e.target.checked ? sel.add(g.label) : sel.delete(g.label)) }), `คุณ ${g.label}${g.display_name ? ` (${g.display_name})` : ''} — ${tr(g.package_name)}`))), {
      actions: [h('button.btn.primary', { onclick: () => { if (!sel.size) return; m.close(); tablePicker('แยกไปโต๊ะ', (t) => !t.session && t.status === 'available', async (t) => {
        try { const r = await api.post(`/api/pos/sessions/${S.panel.id}/split`, { labels: [...sel], table_id: t.id }); BF.toast(`แยกไปโต๊ะ ${t.code} • QR ใหม่ ${r.to.print_jobs.length ? 'ส่งพิมพ์แล้ว' : ''}`, 'success'); loadPanel(S.panel.id); refreshTables(); } catch (e) { BF.error(e); }
      }); } }, 'เลือกโต๊ะปลายทาง')] });
  }
  function editGuests() {
    const p = S.panel; const pkgs = S.boot.packages.filter((x) => x.active);
    const changes = {}; const add = {};
    const rows = p.guests.map((g) => {
      const sel = h('select', { onchange: (e) => { const [pid, code] = e.target.value.split('|'); changes[g.label] = { label: g.label, package_id: Number(pid), price_code: code }; } },
        pkgs.flatMap((pk) => pk.prices.map((pr) => h('option', { value: `${pk.id}|${pr.code}`, selected: pk.id === g.package_id && pr.code === g.price_code }, `${tr(pk.name)} — ${tr(pr.label)} (${baht(pr.price)})`))));
      return h('div.row', null, h('b', { style: { width: '40px' } }, g.label), h('div.grow', null, sel));
    });
    const addRows = pkgs.flatMap((pk) => pk.prices.map((pr) => { const k = `${pk.id}|${pr.code}`; const inp = h('input', { type: 'number', min: 0, value: 0, style: { width: '80px' }, oninput: (e) => { add[k] = Number(e.target.value) || 0; } }); return h('div.row', null, h('span.grow', null, `${tr(pk.name)} — ${tr(pr.label)}`), inp); }));
    const m = BF.modal('ลูกค้า / เปลี่ยนแพ็กเกจ', h('div.form', null, h('h4', null, 'เปลี่ยนแพ็กเกจรายคน'), rows, h('h4', null, 'เพิ่มลูกค้า'), addRows), { wide: true,
      actions: [h('button.btn', { onclick: () => m.close() }, 'ยกเลิก'), h('button.btn.primary', { onclick: async () => {
        try {
          await api.post(`/api/pos/sessions/${p.id}/guests`, { change: Object.values(changes), add: Object.entries(add).filter(([, n]) => n > 0).map(([k, count]) => { const [package_id, price_code] = k.split('|'); return { package_id: Number(package_id), price_code, count }; }) });
          m.close(); BF.toast('บันทึกแล้ว', 'success'); loadPanel(p.id); refreshTables();
        } catch (e) { BF.error(e); }
      } }, 'บันทึก')] });
  }
  function linkMember() {
    memberPicker(async (mm) => { try { await api.post(`/api/pos/sessions/${S.panel.id}/member`, { member_id: mm.id }); BF.toast('ผูกสมาชิกแล้ว', 'success'); loadPanel(S.panel.id); } catch (e) { BF.error(e); } }, { sessionId: S.panel.id });
  }
  function discountDialog() {
    const p = S.panel;
    const code = h('input', { placeholder: 'รหัสโปรโมชั่น / รหัสแลกสิทธิ์ของสมาชิก', style: { textTransform: 'uppercase' } });
    const type = h('select', null, h('option', { value: 'amount' }, 'จำนวนเงิน (บาท)'), h('option', { value: 'percent' }, 'เปอร์เซ็นต์ (%)'));
    const val = h('input', { type: 'number', min: 0, step: '0.01', value: p.manual_discount ? (p.manual_discount.value / 100) : '' });
    const reason = h('input', { placeholder: 'เหตุผล', value: p.manual_discount ? p.manual_discount.reason : '' });
    const m = BF.modal('ส่วนลด / โปรโมชั่น', h('div.form', null,
      h('fieldset', null, h('legend', null, 'ใช้โปรโมชั่น'), h('div.row', null, h('div.grow', null, code), h('button.btn.primary', { onclick: async () => { try { await api.post(`/api/pos/sessions/${p.id}/promo`, { code: code.value }); BF.toast('ใช้โปรโมชั่นแล้ว', 'success'); m.close(); loadPanel(p.id); } catch (e) { BF.error(e); } } }, 'ใช้'))),
      p.member ? h('button.btn', { onclick: () => { m.close(); memberRedeem(p.member.id, p.id); } }, `แลกคะแนนของ ${p.member.first_name || p.member.code}`) : null,
      h('fieldset', null, h('legend', null, 'ส่วนลดโดยพนักงาน'), h('div.form-grid', null, h('label', null, 'ประเภท', type), h('label', null, 'มูลค่า', val), h('label', null, 'เหตุผล', reason)),
        h('div.row', null, h('button.btn.primary', { onclick: async () => {
          try {
            await BF.withApproval((approval) => api.post(`/api/pos/sessions/${p.id}/discount`, { type: type.value, value: Math.round(Number(val.value || 0) * 100), reason: reason.value, approval }), 'ส่วนลดเกินเกณฑ์ต้องได้รับอนุมัติ');
            BF.toast('บันทึกส่วนลดแล้ว', 'success'); m.close(); loadPanel(p.id);
          } catch (e) { BF.error(e); }
        } }, 'บันทึกส่วนลด'), h('button.btn', { onclick: async () => { try { await api.post(`/api/pos/sessions/${p.id}/discount`, { value: 0 }); m.close(); loadPanel(p.id); } catch (e) { BF.error(e); } } }, 'ล้างส่วนลด')))));
    if (p.manual_discount) type.value = p.manual_discount.type;
  }
  function adjustDialog() {
    const p = S.panel;
    const code = h('select', null, h('option', { value: 'leftover' }, 'ค่าปรับอาหารเหลือ'), h('option', { value: 'custom' }, 'รายการเพิ่มเติมอื่น'));
    const label = h('input', { placeholder: 'คำอธิบาย' }); const amt = h('input', { type: 'number', min: 0, step: '0.01' });
    const m = BF.modal('ค่าปรับ / รายการเพิ่ม', h('div.form', null, h('label', null, 'ประเภท', code), h('label', null, 'คำอธิบาย', label), h('label', null, 'จำนวนเงิน (บาท)', amt),
      h('button.btn', { onclick: async () => { try { await BF.withApproval((approval) => api.post(`/api/pos/sessions/${p.id}/adjustments`, { code: 'waive_overtime', approval }), 'ยกเว้นค่าปรับเกินเวลาต้องได้รับอนุมัติ'); m.close(); loadPanel(p.id); } catch (e) { BF.error(e); } } }, 'ยกเว้นค่าปรับเกินเวลา')), {
      actions: [h('button.btn.primary', { onclick: async () => { try { await api.post(`/api/pos/sessions/${p.id}/adjustments`, { code: code.value, label: label.value || undefined, amount: toSatang(amt.value) }); m.close(); loadPanel(p.id); } catch (e) { BF.error(e); } } }, 'เพิ่มรายการ')] });
  }

  // staff ordering on behalf of customers
  async function staffOrder() {
    const p = S.panel;
    let menu; try { menu = await api.get(`/api/pos/sessions/${p.id}/menu`); } catch (e) { return BF.error(e); }
    const cart = new Map(); let guest = ''; let q = '';
    const list = h('div.staff-menu'); const cartEl = h('div.staff-cart');
    const sendBtn = h('button.btn.primary', { onclick: send }, 'ส่งออเดอร์');
    const draw = () => {
      const items = menu.items.filter((i) => !q || tr(i.name).toLowerCase().includes(q) || (i.name.en || '').toLowerCase().includes(q));
      mount(list, menu.categories.map((c) => { const its = items.filter((i) => i.category_id === c.id); return its.length ? h('div', null, h('h4', null, tr(c.name)), h('div.menu-buttons', null, its.map((i) => h('button.menu-btn', { disabled: i.status !== 'available', onclick: () => pick(i) }, i.image ? h('img', { src: i.image, alt: '', loading: 'lazy' }) : null, h('span', null, tr(i.name)), i.extra_price ? h('small', null, `+${money(i.extra_price, 0)}`) : null, i.status !== 'available' ? h('small', null, 'หมด') : null)))) : null; }));
      const lines = [...cart.values()];
      mount(cartEl, lines.length ? lines.map((l) => h('div.row.between', null, h('span.grow', null, `${tr(l.item.name)}${l.labels.length ? ` (${l.labels.join(', ')})` : ''}`), h('div.stepper', null, h('button', { onclick: () => { l.qty--; if (!l.qty) cart.delete(l.key); draw(); } }, '−'), h('span', null, l.qty), h('button', { onclick: () => { l.qty++; draw(); } }, '+')))) : h('div.muted', null, 'ยังไม่ได้เลือกรายการ'));
      sendBtn.disabled = !lines.length;
    };
    function pick(i) {
      if (!i.options.length) { const k = `${i.id}`; const ex = cart.get(k); if (ex) ex.qty++; else cart.set(k, { key: k, item: i, qty: 1, options: [], labels: [] }); return draw(); }
      const ch = {}; const body = h('div.form', null, i.options.map((o) => h('label', null, `${tr(o.name)}${o.required ? ' *' : ''}`, h('select', { multiple: o.type === 'multi', onchange: (e) => { ch[o.id] = [...e.target.selectedOptions].map((x) => x.value).filter(Boolean); } }, o.type === 'single' ? h('option', { value: '' }, '—') : null, o.choices.map((c) => h('option', { value: c.id }, tr(c.name)))))));
      const mm = BF.modal(tr(i.name), body, { actions: [h('button.btn.primary', { onclick: () => {
        const options = Object.entries(ch).filter(([, v]) => v.length).map(([option_id, choice_ids]) => ({ option_id: Number(option_id), choice_ids }));
        const labels = i.options.flatMap((o) => (ch[o.id] || []).map((cid) => tr((o.choices.find((c) => String(c.id) === cid) || {}).name)));
        const k = JSON.stringify([i.id, options]); const ex = cart.get(k); if (ex) ex.qty++; else cart.set(k, { key: k, item: i, qty: 1, options, labels });
        mm.close(); draw();
      } }, 'เพิ่ม')] });
    }
    const idem = ikey();
    async function send() {
      sendBtn.disabled = true;
      try { await api.post(`/api/pos/sessions/${p.id}/orders`, { idempotency_key: idem, guest_label: guest || undefined, items: [...cart.values()].map((l) => ({ menu_item_id: l.item.id, qty: l.qty, options: l.options })) }); BF.toast('ส่งออเดอร์แล้ว', 'success'); m.close(); loadPanel(p.id); } catch (e) { BF.error(e); sendBtn.disabled = false; }
    }
    const m = BF.modal(`สั่งอาหาร • โต๊ะ ${p.table.code}`, h('div.staff-order', null,
      h('div', null, h('div.row', null, h('input.grow', { placeholder: 'ค้นหาเมนู', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }),
        p.guests.length > 1 ? h('select', { style: { width: 'auto' }, onchange: (e) => { guest = e.target.value; } }, h('option', { value: '' }, 'ทั้งโต๊ะ'), p.guests.map((g) => h('option', { value: g.label }, `คุณ ${g.label}`))) : null), list),
      h('div', null, h('h4', null, 'รายการที่เลือก'), cartEl)), { wide: true, actions: [sendBtn] });
    draw();
  }

  // ---------- checkout ----------
  async function checkout() {
    const p = S.panel;
    if (p.status === 'active') {
      const b = p.bill;
      const mode = h('select', null, h('option', { value: 'none' }, 'ไม่แบ่งบิล'), h('option', { value: 'equal' }, 'แบ่งเท่า ๆ กัน'), p.guests.length > 1 ? h('option', { value: 'guests' }, 'แบ่งตามลูกค้า') : null, h('option', { value: 'amounts' }, 'กำหนดยอดเอง'));
      const extra = h('div');
      const groupsSel = {};
      mode.onchange = () => {
        if (mode.value === 'equal') mount(extra, h('label', null, 'จำนวนบิล', h('input#split-n', { type: 'number', min: 2, value: 2 })));
        else if (mode.value === 'guests') mount(extra, h('div.form', null, h('div.muted.small', null, 'กำหนดเลขบิลให้ลูกค้าแต่ละคน'), p.guests.map((g) => { groupsSel[g.label] = 1; return h('div.row', null, h('span.grow', null, `คุณ ${g.label} — ${tr(g.package_name)}`), h('input', { type: 'number', min: 1, value: 1, style: { width: '80px' }, oninput: (e) => { groupsSel[g.label] = Number(e.target.value) || 1; } })); })));
        else if (mode.value === 'amounts') mount(extra, h('label', null, `ยอดแต่ละบิล คั่นด้วยจุลภาค (รวม ${money(b.total)})`, h('input#split-a', { placeholder: 'เช่น 3000, 2879.12' })));
        else mount(extra);
      };
      const m = BF.modal(`คิดเงิน • โต๊ะ ${p.table.code}`, h('div.form', null, billView(p), h('label', null, 'การแบ่งบิล', mode), extra), {
        actions: [h('button.btn', { onclick: () => m.close() }, 'ยกเลิก'), h('button.btn.primary', { onclick: async () => {
          let split = { mode: mode.value };
          if (mode.value === 'equal') split.count = Number($('#split-n').value);
          if (mode.value === 'guests') { const g = {}; for (const [l, n] of Object.entries(groupsSel)) (g[n] ||= []).push(l); split.groups = Object.keys(g).sort().map((k) => g[k]); }
          if (mode.value === 'amounts') split.amounts = $('#split-a').value.split(',').map((x) => toSatang(x.trim())).filter((x) => x > 0);
          try { await api.post(`/api/pos/sessions/${p.id}/checkout`, { split }); m.close(); await loadPanel(p.id); payDialog(); } catch (e) { BF.error(e); }
        } }, 'สร้างบิล')] });
      return;
    }
    payDialog();
  }
  async function cancelCheckout() { try { await api.post(`/api/pos/sessions/${S.panel.id}/checkout/cancel`); loadPanel(S.panel.id); } catch (e) { BF.error(e); } }

  function payDialog() {
    const p = S.panel;
    const bills = p.bills.filter((b) => b.status === 'open');
    if (!bills.length) return BF.toast('ไม่มีบิลค้างชำระ', 'info');
    const bill = bills[0];
    const due = bill.total - bill.paid_total;
    const methods = S.boot.payment_methods;
    const pays = [];
    let method = methods[0];
    const amount = h('input', { type: 'number', step: '0.01', min: 0, value: (due / 100).toFixed(2) });
    const received = h('input', { type: 'number', step: '0.01', min: 0, value: (due / 100).toFixed(2) });
    const ref = h('input', { placeholder: 'เลขอ้างอิง (ถ้ามี)' });
    const info = h('div.pay-info');
    const listEl = h('div');
    const tiToggle = h('input', { type: 'checkbox' });
    const ti = { name: h('input'), tax_id: h('input', { inputmode: 'numeric', maxlength: 13 }), address: h('textarea', { rows: 2 }), branch_label: h('input', { value: 'สำนักงานใหญ่' }) };
    const tiBox = h('div.form.hidden', null, h('label', null, 'ชื่อผู้ซื้อ / บริษัท', ti.name), h('label', null, 'เลขประจำตัวผู้เสียภาษี (13 หลัก)', ti.tax_id), h('label', null, 'สาขา', ti.branch_label), h('label', null, 'ที่อยู่', ti.address));
    tiToggle.onchange = () => tiBox.classList.toggle('hidden', !tiToggle.checked);
    const remaining = () => due - pays.reduce((a, x) => a + x.amount, 0);
    const methodBtns = h('div.method-row');
    const drawMethods = () => mount(methodBtns, methods.map((mm) => h('button.chip', { class: mm.id === method.id ? 'active' : '', onclick: () => { method = mm; drawMethods(); drawInfo(); } }, { cash: '💵', promptpay: '📱', transfer: '🏦', card: '💳', other: '•' }[mm.type], ' ', mm.name)));
    const drawInfo = async () => {
      const rem = remaining();
      amount.value = (rem / 100).toFixed(2);
      if (method.type === 'cash') {
        const quick = [rem, Math.ceil(rem / 10000) * 10000, Math.ceil(rem / 50000) * 50000, Math.ceil(rem / 100000) * 100000].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
        received.value = (rem / 100).toFixed(2);
        mount(info, h('label', null, 'รับเงิน', received), h('div.row', null, quick.map((v) => h('button.btn.sm', { onclick: () => { received.value = (v / 100).toFixed(2); drawChange(); } }, money(v, 0)))), h('div#change.big-change'));
        received.oninput = drawChange; drawChange();
      } else if (method.type === 'promptpay') {
        mount(info, h('div.muted', null, 'กำลังสร้าง QR พร้อมเพย์…'));
        try { const r = await api.get(`/api/pos/bills/${bill.id}/promptpay?method_id=${method.id}&amount=${toSatang(amount.value)}`); mount(info, h('div.center', null, h('img', { src: r.qr, alt: 'PromptPay', style: { width: '220px', margin: '0 auto' } }), h('div', null, `PromptPay ${money(r.amount)} บาท`), h('div.muted.small', null, 'ตรวจสอบยอดเงินเข้าในแอปธนาคารก่อนกดยืนยัน')), h('label', null, 'เลขอ้างอิง', ref)); } catch (e) { mount(info, h('div.warn', null, e.message), h('label', null, 'เลขอ้างอิง', ref)); }
      } else mount(info, h('label', null, 'เลขอ้างอิง / เลขท้ายบัตร', ref));
    };
    const drawChange = () => { const c = toSatang(received.value) - toSatang(amount.value); const el = $('#change'); if (el) el.textContent = c >= 0 ? `เงินทอน ${money(c)}` : `ขาดอีก ${money(-c)}`; };
    const drawList = () => mount(listEl, pays.map((x, i) => h('div.row.between', null, h('span', null, `${x.name} ${money(x.amount)}${x.received && x.received !== x.amount ? ` (รับ ${money(x.received)})` : ''}`), h('button.btn.sm.ghost', { onclick: () => { pays.splice(i, 1); drawList(); drawInfo(); } }, '✕'))), h('div.sum-row.total', null, h('span', null, 'คงค้าง'), h('span', null, money(remaining()))));
    const addSplit = h('button.btn', { onclick: () => {
      const a = toSatang(amount.value); if (!(a > 0) || a > remaining()) return BF.toast('ยอดไม่ถูกต้อง', 'error');
      pays.push({ method_id: method.id, name: method.name, amount: a, received: method.type === 'cash' ? Math.max(a, toSatang(received.value)) : undefined, reference: ref.value || undefined });
      ref.value = ''; drawList(); drawInfo();
    } }, '+ แบ่งจ่ายหลายช่องทาง');
    const idem = ikey();
    const payBtn = h('button.btn.primary.lg', { onclick: async () => {
      const list = pays.slice();
      if (remaining() > 0) list.push({ method_id: method.id, amount: toSatang(amount.value), received: method.type === 'cash' ? toSatang(received.value) : undefined, reference: ref.value || undefined });
      payBtn.disabled = true;
      try {
        const r = await api.post(`/api/pos/bills/${bill.id}/pay`, { idempotency_key: idem, payments: list, tax_invoice: tiToggle.checked ? { name: ti.name.value, tax_id: ti.tax_id.value, address: ti.address.value, branch_label: ti.branch_label.value } : undefined });
        m.close();
        const change = r.bill.payments.reduce((a, x) => a + x.change_amount, 0);
        if (r.session_closed) {
          BF.modal('ชำระเงินสำเร็จ', h('div.center', null, h('div', { style: { fontSize: '56px' } }, '✅'), h('h2', null, `ปิดโต๊ะ ${p.table.code} แล้ว`), change ? h('div.big-change', null, `เงินทอน ${money(change)}`) : null, h('p.muted', null, 'QR เดิมถูกยกเลิกแล้ว • ใบเสร็จส่งพิมพ์ตามการตั้งค่า')));
          if (panelModal) panelModal.close();
        } else {
          BF.toast(`ชำระบิล ${r.bill.bill_no} แล้ว${change ? ` • ทอน ${money(change)}` : ''}`, 'success', 5000);
          await loadPanel(p.id); payDialog();
        }
        refreshTables();
      } catch (e) { BF.error(e); payBtn.disabled = false; }
    } }, `ยืนยันรับชำระ`);
    const m = BF.modal(`รับชำระ ${bill.bill_no}${bill.split_label ? ` (${bill.split_label})` : ''} • ${bills.length > 1 ? `เหลือ ${bills.length} บิล` : ''}`, h('div.form', null,
      h('div.pay-due', null, h('span.muted', null, 'ยอดที่ต้องชำระ'), h('div.big', null, baht(due))),
      methodBtns, h('label', null, 'จำนวนเงิน', amount), info, listEl, addSplit,
      h('label.check', null, tiToggle, 'ออกใบกำกับภาษีเต็มรูป'), tiBox), { actions: [h('button.btn', { onclick: () => m.close() }, 'ปิด'), payBtn] });
    amount.oninput = () => { if (method.type === 'cash') drawChange(); };
    drawMethods(); drawInfo(); drawList();
  }

  // ---------- calls ----------
  async function loadCalls() { try { const r = await api.get('/api/pos/calls'); S.calls = r.calls; updateCallDot(); if (S.tab === 'calls') renderTab(); } catch { /* ignore */ } }
  function upsertCall(c) { const i = S.calls.findIndex((x) => x.id === c.id); if (i >= 0) S.calls[i] = c; else S.calls.push(c); updateCallDot(); if (S.tab === 'calls') renderTab(); refreshTables(); }
  function updateCallDot() { const n = S.calls.filter((c) => c.status === 'pending').length; const d = $('#calldot'); if (d) { d.textContent = n; d.classList.toggle('hidden', !n); } }
  function callRow(c) {
    const open = ['pending', 'accepted', 'in_progress'].includes(c.status);
    return h('div.call-card', { class: `call-${c.status}` },
      h('div.call-table', null, c.table_code),
      h('div.grow', null, h('b', null, tr(c.label)), c.note ? h('div.small', null, c.note) : null, h('div.muted.small', null, `${hhmm(c.created_at)} • ${CALL_ST[c.status]}${c.accepted_by_name ? ` • ${c.accepted_by_name}` : ''}`)),
      open ? h('div.call-wait.mono', { dataset: { since: c.created_at } }, dur(BF.now() - c.created_at)) : null,
      open && can('call.handle') ? h('div.row', null,
        c.status === 'pending' ? h('button.btn.sm.primary', { onclick: () => callAct(c, 'accepted') }, 'รับงาน') : null,
        c.status !== 'in_progress' ? h('button.btn.sm', { onclick: () => callAct(c, 'in_progress') }, 'กำลังดำเนินการ') : null,
        h('button.btn.sm.success', { onclick: () => callAct(c, 'done') }, 'เสร็จสิ้น'),
        h('button.btn.sm.ghost', { onclick: () => callAct(c, 'cancelled') }, 'ยกเลิก')) : null);
  }
  async function callAct(c, status) { try { const r = await api.post(`/api/pos/calls/${c.id}`, { status }); upsertCall(r.call); } catch (e) { BF.error(e); } }
  function renderCalls(main) {
    const open = S.calls.filter((c) => ['pending', 'accepted', 'in_progress'].includes(c.status)).sort((a, b) => a.created_at - b.created_at);
    const done = S.calls.filter((c) => !['pending', 'accepted', 'in_progress'].includes(c.status)).sort((a, b) => b.created_at - a.created_at);
    mount(main, h('div.pad', null, h('h3', null, `คำขอที่รอดำเนินการ (${open.length})`), open.length ? open.map(callRow) : BF.states.empty('ไม่มีคำขอค้าง', '✅'), h('h3.mt', null, 'เสร็จสิ้นล่าสุด (30 นาที)'), done.map(callRow)));
  }

  // ---------- bills ----------
  async function renderBills(main) {
    const q = h('input', { placeholder: 'ค้นหาเลขบิล / Session', oninput: BF.debounce(() => load(), 300) });
    const list = h('div', null, BF.states.loading(3, 'sk-line'));
    mount(main, h('div.pad', null, h('div.row', null, h('div.grow', null, q)), list));
    async function load() {
      try {
        const r = await api.get(`/api/pos/bills?q=${encodeURIComponent(q.value)}`);
        mount(list, r.bills.length ? h('div.table-wrap', null, h('table.list', null, h('thead', null, h('tr', null, ['เลขบิล', 'โต๊ะ', 'วันที่', 'ยอด', 'ชำระ', 'สถานะ', ''].map((x) => h('th', null, x)))),
          h('tbody', null, r.bills.map((b) => h('tr', null, h('td', null, b.bill_no, b.split_label ? ` (${b.split_label})` : ''), h('td', null, b.table_code), h('td', null, dt(b.paid_at || b.created_at)), h('td.mono', null, money(b.total)), h('td', null, b.payments.map((x) => x.method_name).join(', ')), h('td', null, h('span.badge', null, b.status), b.tax_invoice ? h('span.badge', null, 'ใบกำกับภาษี') : null),
            h('td.nowrap', null,
              b.status !== 'open' ? h('button.btn.sm', { onclick: () => reprint(b, 'receipt') }, 'พิมพ์ซ้ำ') : null,
              ['paid', 'partially_refunded'].includes(b.status) ? h('button.btn.sm', { onclick: () => taxInvoice(b) }, 'ใบกำกับภาษี') : null,
              ['paid', 'partially_refunded'].includes(b.status) && can('payment.refund') ? h('button.btn.sm.danger', { onclick: () => refund(b) }, 'คืนเงิน') : null))))))
          : BF.states.empty('ไม่พบบิล', '🧾'));
      } catch (e) { mount(list, BF.states.error(e, load)); }
    }
    load();
  }
  async function reprint(b, doc) { try { const r = await api.post(`/api/pos/bills/${b.id}/print`, { doc }); BF.toast(`ส่งพิมพ์ (${r.jobs.length})`, 'success'); } catch (e) { BF.error(e); } }
  function taxInvoice(b) {
    const f = { name: h('input'), tax_id: h('input', { maxlength: 13, inputmode: 'numeric' }), branch_label: h('input', { value: 'สำนักงานใหญ่' }), address: h('textarea', { rows: 2 }) };
    if (b.tax_invoice) for (const k of Object.keys(f)) f[k].value = b.tax_invoice[k] || '';
    const m = BF.modal(`ใบกำกับภาษีเต็มรูป • ${b.bill_no}`, h('div.form', null, h('label', null, 'ชื่อผู้ซื้อ', f.name), h('label', null, 'เลขประจำตัวผู้เสียภาษี', f.tax_id), h('label', null, 'สาขา', f.branch_label), h('label', null, 'ที่อยู่', f.address)), {
      actions: [h('button.btn.primary', { onclick: async () => { try { await api.post(`/api/pos/bills/${b.id}/tax-invoice`, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]))); BF.toast('ออกใบกำกับภาษีแล้ว (ส่งพิมพ์)', 'success'); m.close(); renderTab(); } catch (e) { BF.error(e); } } }, 'ออกและพิมพ์')] });
  }
  function refund(b) {
    const amt = h('input', { type: 'number', step: '0.01', value: ((b.paid_total - b.refunded_total) / 100).toFixed(2) }); const reason = h('input', { placeholder: 'เหตุผล (จำเป็น)' });
    const m = BF.modal(`คืนเงิน • ${b.bill_no}`, h('div.form', null, h('div.muted', null, `ชำระแล้ว ${money(b.paid_total)} • คืนแล้ว ${money(b.refunded_total)}`), h('label', null, 'จำนวนเงินคืน', amt), h('label', null, 'เหตุผล', reason), h('div.muted.small', null, 'ต้องได้รับการอนุมัติจากผู้จัดการ • คะแนนสมาชิกจะถูกหักตามสัดส่วน')), {
      actions: [h('button.btn.danger', { onclick: async () => {
        try { const r = await BF.withApproval((approval) => api.post(`/api/pos/bills/${b.id}/refund`, { amount: toSatang(amt.value), reason: reason.value, approval }), 'การคืนเงินต้องได้รับอนุมัติ'); BF.toast(`คืนเงินแล้ว • หักคะแนน ${r.points_reversed}`, 'success'); m.close(); renderTab(); } catch (e) { BF.error(e); }
      } }, 'คืนเงิน')] });
  }

  // ---------- members ----------
  function renderMembers(main) {
    const results = h('div');
    const q = h('input', { placeholder: 'เบอร์โทร / รหัสสมาชิก / ชื่อ / สแกนบาร์โค้ด', oninput: BF.debounce(search, 300), onkeydown: (e) => { if (e.key === 'Enter') search(); } });
    mount(main, h('div.pad', null, h('div.row', null, h('div.grow', null, q), can('member.manage') ? h('button.btn.primary', { onclick: () => registerMember((m) => memberDetail(m.id)) }, '+ สมัครสมาชิก') : null), results));
    q.focus();
    async function search() {
      if (q.value.trim().length < 2) return mount(results);
      try { const r = await api.get(`/api/pos/members?q=${encodeURIComponent(q.value.trim())}`); mount(results, r.members.length ? r.members.map((m) => h('button.list-btn', { onclick: () => memberDetail(m.id) }, h('b', null, `${m.first_name || ''} ${m.last_name || ''}`), h('span.muted', null, ` ${m.code} • ${m.phone} • ${m.points} pts • ${m.tier ? tr(m.tier.name) : ''}`))) : BF.states.empty('ไม่พบสมาชิก', '👤')); } catch (e) { BF.error(e); }
    }
  }
  async function memberDetail(id) {
    let r; try { r = await api.get(`/api/pos/members/${id}`); } catch (e) { return BF.error(e); }
    const m = r.member;
    const modal = BF.modal(`${m.first_name || ''} ${m.last_name || ''} • ${m.code}`, h('div', null,
      h('div.member-head', { style: { background: m.tier ? m.tier.color : 'var(--primary)' } }, h('div', null, h('div', null, m.tier ? tr(m.tier.name) : ''), h('b', null, m.phone), h('div.small', null, `ยอดใช้จ่ายสะสม ${money(m.total_spent)}`)), h('div.right', null, h('div.big', null, m.points), 'คะแนน')),
      h('div.row', null,
        can('points.adjust') ? h('button.btn.sm', { onclick: () => adjustPoints(m) }, '± ปรับคะแนน') : null,
        h('button.btn.sm', { onclick: () => { modal.close(); memberRedeem(m.id); } }, '🎁 แลกสิทธิ์')),
      h('h4', null, 'สิทธิ์ที่แลกแล้ว'), r.redemptions.length ? r.redemptions.map((x) => h('div.row.between.line', null, h('span', null, `${tr(x.name)} • ${x.code}`), h('span', null, h('span.badge', null, x.status), x.status === 'issued' ? h('button.btn.sm.ghost', { onclick: async () => { try { await api.post(`/api/pos/redemptions/${x.id}/cancel`); BF.toast('ยกเลิกสิทธิ์และคืนคะแนนแล้ว', 'success'); modal.close(); memberDetail(id); } catch (e) { BF.error(e); } } }, 'ยกเลิก/คืนคะแนน') : null))) : h('div.muted', null, '—'),
      h('h4', null, 'ประวัติคะแนน'), h('div.table-wrap', { style: { maxHeight: '260px' } }, h('table.list', null, h('tbody', null, r.history.map((x) => h('tr', null, h('td', null, dt(x.created_at)), h('td', null, x.reason || x.type), h('td.right.mono', { style: { color: x.points >= 0 ? 'var(--success)' : 'var(--danger)' } }, x.points > 0 ? `+${x.points}` : x.points)))))),
      h('h4', null, 'ประวัติการใช้บริการ'), r.visits.length ? r.visits.map((v) => h('div.row.between.line', null, h('span', null, `${dt(v.closed_at)} • โต๊ะ ${v.table_code}`), h('span', null, money(v.total)))) : h('div.muted', null, '—')), { wide: true });
  }
  function adjustPoints(m) {
    const pts = h('input', { type: 'number', placeholder: 'เช่น 50 หรือ -20' }); const reason = h('input', { placeholder: 'เหตุผล (จำเป็น)' });
    const md = BF.modal('ปรับคะแนน', h('div.form', null, h('label', null, 'คะแนน (+/-)', pts), h('label', null, 'เหตุผล', reason)), { actions: [h('button.btn.primary', { onclick: async () => {
      try { await BF.withApproval((approval) => api.post(`/api/pos/members/${m.id}/points`, { points: Number(pts.value), reason: reason.value, approval }), 'การปรับคะแนนต้องได้รับอนุมัติ'); BF.toast('ปรับคะแนนแล้ว', 'success'); md.close(); memberDetail(m.id); } catch (e) { BF.error(e); }
    } }, 'บันทึก')] });
  }
  async function memberRedeem(memberId, sessionId) {
    let r; try { r = await api.get(`/api/pos/members/${memberId}`); } catch (e) { return BF.error(e); }
    const md = BF.modal('แลกสิทธิ์', h('div', null, r.promotions.length ? r.promotions.map((p) => h('div.row.between.line', null, h('div', null, h('b', null, tr(p.name)), h('div.muted.small', null, `${p.points_cost} คะแนน${p.ineligible ? ` • ${p.ineligible}` : ''}`)),
      h('button.btn.sm.primary', { disabled: !!p.ineligible, onclick: async () => {
        try { const x = await api.post(`/api/pos/members/${memberId}/redeem`, { promotion_id: p.id, session_id: sessionId }); BF.toast(`แลกสิทธิ์แล้ว รหัส ${x.redemption.code}${sessionId ? ' (ใช้กับโต๊ะนี้)' : ''}`, 'success', 6000); md.close(); if (sessionId) loadPanel(sessionId); } catch (e) { BF.error(e); }
      } }, sessionId ? 'แลกและใช้กับโต๊ะนี้' : 'แลกสิทธิ์'))) : BF.states.empty('ไม่มีโปรโมชั่น', '🎁')));
  }

  // ---------- print jobs ----------
  async function renderPrints(main) {
    mount(main, h('div.pad', null, BF.states.loading(3, 'sk-line')));
    try {
      const r = await api.get('/api/pos/print-jobs');
      mount(main, h('div.pad', null, h('p.muted', null, 'สถานะงานพิมพ์ล่าสุด • ตั้งค่าเครื่องพิมพ์ได้ที่ Admin › เครื่องพิมพ์'),
        r.jobs.length ? h('div.table-wrap', null, h('table.list', null, h('thead', null, h('tr', null, ['#', 'เวลา', 'เอกสาร', 'สถานะ', 'ครั้งที่', 'ข้อผิดพลาด', ''].map((x) => h('th', null, x)))),
          h('tbody', null, r.jobs.map((j) => h('tr', null, h('td', null, j.id), h('td', null, dt(j.created_at)), h('td', null, j.doc_label), h('td', null, h(`span.badge.st.st-${j.status}`, null, JOB_ST[j.status])), h('td', null, j.attempts), h('td.small', null, j.error || ''), h('td', null, ['failed', 'printed'].includes(j.status) ? h('button.btn.sm', { onclick: async () => { await retryJob(j.id); renderTab(); } }, j.status === 'failed' ? 'ลองใหม่' : 'พิมพ์ซ้ำ') : null))))))
          : BF.states.empty('ยังไม่มีงานพิมพ์', '🖨')));
    } catch (e) { mount(main, BF.states.error(e, () => renderPrints(main))); }
  }

  start();
})();
