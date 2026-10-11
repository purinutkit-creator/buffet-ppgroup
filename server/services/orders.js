'use strict';
// Order placement with full server-side validation, idempotency and kitchen routing.
const db = require('../db');
const { err, now, localParts, inWindow, tr } = require('../lib/util');
const { branchSettings } = require('./settings');
const rt = require('../realtime');

const ITEM_STATUSES = ['received', 'sent', 'preparing', 'cooking', 'ready', 'served', 'cancelled', 'unavailable'];
const PROGRESS = { received: 0, sent: 1, preparing: 2, cooking: 3, ready: 4, served: 5 };
const MAX_LINES = 50;

function aggregateStatus(statuses) {
  const live = statuses.filter((s) => s !== 'cancelled' && s !== 'unavailable');
  if (!live.length) return statuses.includes('unavailable') ? 'unavailable' : 'cancelled';
  return live.reduce((a, b) => (PROGRESS[b] < PROGRESS[a] ? b : a));
}

function orderNo(branchId, tz) {
  const day = localParts(now(), tz).date.replace(/-/g, '');
  return `ORD${String(db.nextSeq(`order:${branchId}:${day}`)).padStart(3, '0')}`;
}

/**
 * input: {guest_label?, device_id?, idempotency_key, items:[{menu_item_id, qty, options:[{option_id, choice_ids:[...]}], note}]}
 * ctx:   {source:'customer'|'staff', staff_id?}
 */
function placeOrder(sessionId, input, ctx = { source: 'customer' }) {
  const d = db.get();
  const key = String(input.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw err(400, 'idempotency_key_required', 'ต้องมี Idempotency Key');
  const lines = Array.isArray(input.items) ? input.items : [];
  if (!lines.length) throw err(400, 'empty_order', 'ไม่มีรายการอาหาร');
  if (lines.length > MAX_LINES) throw err(400, 'too_many_lines', 'รายการมากเกินไป');

  const result = d.transaction(() => {
    const dup = d.prepare('SELECT id FROM orders WHERE session_id=? AND idempotency_key=?').get(sessionId, key);
    if (dup) return { orderId: dup.id, duplicate: true };

    const s = d.prepare('SELECT * FROM table_sessions WHERE id=?').get(sessionId);
    if (!s || !['active', 'billing'].includes(s.status)) throw err(410, 'session_ended', 'โต๊ะนี้สิ้นสุดการให้บริการแล้ว');
    if (s.status === 'billing') throw err(409, 'billing_in_progress', 'โต๊ะอยู่ระหว่างชำระเงิน ไม่สามารถสั่งอาหารเพิ่มได้');
    const settings = branchSettings(s.branch_id);
    const t = now();
    const isStaff = ctx.source === 'staff';
    if (t < s.start_at - 60000) throw err(409, 'not_started', 'ยังไม่ถึงเวลาเริ่มรับประทาน');
    if (!isStaff && settings.lock_orders_after_time_up && t >= s.order_end_at) throw err(409, 'ordering_closed', 'หมดเวลาสั่งอาหารแล้ว');

    const guests = d.prepare(`SELECT g.*, p.max_per_round, p.round_per_guest, p.round_interval_min, p.max_per_item_per_guest FROM session_guests g JOIN buffet_packages p ON p.id=g.package_id WHERE g.session_id=? AND g.active=1`).all(s.id);
    const distinctPkgs = [...new Set(guests.map((g) => g.package_id))];
    let guest = null;
    if (input.guest_label) {
      guest = guests.find((g) => g.label === input.guest_label);
      if (!guest) throw err(400, 'invalid_guest', 'ไม่พบผู้ใช้บริการในโต๊ะนี้');
    } else if (distinctPkgs.length > 1 && !isStaff) {
      throw err(400, 'guest_required', 'กรุณาเลือกชื่อผู้สั่ง (โต๊ะนี้มีหลายแพ็กเกจ)');
    }
    const pkgIds = guest ? [guest.package_id] : distinctPkgs;
    const rule = guest || guests[0];

    // Round limits (customer only)
    const totalQty = lines.reduce((a, l) => a + (parseInt(l.qty, 10) || 0), 0);
    if (!isStaff) {
      if (rule.max_per_round > 0) {
        const cap = rule.max_per_round * (rule.round_per_guest ? (guest ? 1 : guests.length) : 1);
        if (totalQty > cap) throw err(409, 'round_limit', `สั่งได้สูงสุด ${cap} จานต่อรอบ`, { max: cap });
      }
      if (rule.round_interval_min > 0 && s.last_order_at) {
        const wait = s.last_order_at + rule.round_interval_min * 60000 - t;
        if (wait > 0) throw err(409, 'round_interval', `กรุณารออีก ${Math.ceil(wait / 60000)} นาทีก่อนสั่งรอบถัดไป`, { wait_ms: wait });
      }
    }

    const lp = localParts(t, settings.timezone);
    const prepared = [];
    const ph = pkgIds.map(() => '?').join(',');
    for (const l of lines) {
      const qty = parseInt(l.qty, 10);
      if (!(qty > 0 && qty <= 99)) throw err(400, 'invalid_qty', 'จำนวนไม่ถูกต้อง');
      const m = d.prepare(`SELECT m.*, MIN(COALESCE(mp.extra_price, m.extra_price)) eff_extra FROM menu_items m JOIN menu_item_packages mp ON mp.menu_item_id=m.id AND mp.package_id IN (${ph})
        WHERE m.id=? AND (m.branch_id IS NULL OR m.branch_id=?) GROUP BY m.id`).get(...pkgIds, l.menu_item_id, s.branch_id);
      if (!m) throw err(403, 'not_in_package', 'รายการนี้ไม่อยู่ในแพ็กเกจของคุณ', { menu_item_id: l.menu_item_id });
      const name = db.J(m.name, {});
      if (m.status !== 'available') throw err(409, 'item_unavailable', `${tr(name)} หมดชั่วคราว`, { menu_item_id: m.id });
      if (!inWindow(lp.minutes, m.available_from, m.available_to)) throw err(409, 'item_not_now', `${tr(name)} สั่งได้ช่วง ${m.available_from}-${m.available_to}`, { menu_item_id: m.id });
      if (m.max_per_order > 0 && qty > m.max_per_order) throw err(409, 'max_per_order', `${tr(name)} สั่งได้สูงสุด ${m.max_per_order} ต่อครั้ง`, { menu_item_id: m.id, max: m.max_per_order });

      // per guest / per table caps across the session (pending lines in this order included)
      const pendingSame = prepared.filter((p) => p.m.id === m.id).reduce((a, p) => a + p.qty, 0);
      const perGuest = m.max_per_guest || rule.max_per_item_per_guest || 0;
      if (perGuest > 0) {
        const used = guest
          ? d.prepare("SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE session_id=? AND menu_item_id=? AND guest_label=? AND status NOT IN ('cancelled','unavailable')").get(s.id, m.id, guest.label).q
          : d.prepare("SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE session_id=? AND menu_item_id=? AND status NOT IN ('cancelled','unavailable')").get(s.id, m.id).q;
        const cap = guest ? perGuest : perGuest * guests.length;
        if (used + pendingSame + qty > cap && !isStaff) throw err(409, 'max_per_guest', `${tr(name)} สั่งได้สูงสุด ${cap} ที่ (สั่งแล้ว ${used})`, { menu_item_id: m.id, max: cap, used });
      }
      if (m.max_per_table > 0) {
        const used = d.prepare("SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE session_id=? AND menu_item_id=? AND status NOT IN ('cancelled','unavailable')").get(s.id, m.id).q;
        if (used + pendingSame + qty > m.max_per_table && !isStaff) throw err(409, 'max_per_table', `${tr(name)} สั่งได้สูงสุด ${m.max_per_table} ที่ต่อโต๊ะ`, { menu_item_id: m.id, max: m.max_per_table, used });
      }

      // options
      const opts = d.prepare('SELECT * FROM menu_options WHERE menu_item_id=? ORDER BY sort, id').all(m.id);
      const chosen = Array.isArray(l.options) ? l.options : [];
      const optSnap = [];
      let optPrice = 0;
      for (const o of opts) {
        const pick = chosen.find((c) => Number(c.option_id) === o.id);
        const ids = pick && Array.isArray(pick.choice_ids) ? pick.choice_ids.map(String) : [];
        const choices = db.J(o.choices, []);
        if (o.required && !ids.length) throw err(400, 'option_required', `กรุณาเลือก ${tr(db.J(o.name, {}))}`);
        if (o.type === 'single' && ids.length > 1) throw err(400, 'option_single', 'เลือกได้ 1 ตัวเลือก');
        if (o.max_select > 0 && ids.length > o.max_select) throw err(400, 'option_max', `เลือกได้สูงสุด ${o.max_select}`);
        for (const cid of ids) {
          const c = choices.find((x) => String(x.id) === cid);
          if (!c) throw err(400, 'invalid_choice', 'ตัวเลือกไม่ถูกต้อง');
          optPrice += Number(c.price || 0);
          optSnap.push({ option: db.J(o.name, {}), choice: c.name, price: Number(c.price || 0) });
        }
      }
      for (const c of chosen) if (!opts.some((o) => o.id === Number(c.option_id))) throw err(400, 'invalid_option', 'ตัวเลือกไม่ถูกต้อง');
      const note = l.note ? String(l.note).slice(0, 200) : null;
      prepared.push({ m, qty, optSnap, note, unit_extra: (m.eff_extra || 0) + optPrice, name });
    }

    const no = orderNo(s.branch_id, settings.timezone);
    const o = d.prepare('INSERT INTO orders(branch_id, session_id, order_no, guest_label, device_id, idempotency_key, source, staff_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(s.branch_id, s.id, no, guest ? guest.label : null, input.device_id ? String(input.device_id).slice(0, 64) : null, key, ctx.source, ctx.staff_id || null, t);
    const orderId = o.lastInsertRowid;
    // one kitchen ticket per station
    const tickets = {};
    const insItem = d.prepare(`INSERT INTO order_items(order_id, session_id, menu_item_id, name, qty, options, note, unit_extra, unit_cost, guest_label, station_id, ticket_id, status, status_at, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?)`);
    for (const p of prepared) {
      const st = p.m.station_id || 0;
      if (!tickets[st]) tickets[st] = d.prepare("INSERT INTO kitchen_tickets(branch_id, order_id, session_id, station_id, status, created_at) VALUES(?,?,?,?,'received',?)").run(s.branch_id, orderId, s.id, p.m.station_id || null, t).lastInsertRowid;
      insItem.run(orderId, s.id, p.m.id, JSON.stringify(p.name), p.qty, JSON.stringify(p.optSnap), p.note, p.unit_extra, p.m.cost || 0, guest ? guest.label : null, p.m.station_id || null, tickets[st], t, t);
    }
    d.prepare('UPDATE table_sessions SET last_order_at=? WHERE id=?').run(t, s.id);
    return { orderId, duplicate: false, ticketIds: Object.values(tickets), branchId: s.branch_id };
  })();

  if (!result.duplicate) dispatchToKitchen(result.orderId);
  return { ...orderDetail(result.orderId), duplicate: result.duplicate };
}

// After commit: mark items sent, notify KDS/staff/customers, queue kitchen slips (only this order's new items).
function dispatchToKitchen(orderId) {
  const d = db.get();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  d.prepare("UPDATE order_items SET status='sent', status_at=? WHERE order_id=? AND status='received'").run(now(), orderId);
  d.prepare("UPDATE kitchen_tickets SET status='sent' WHERE order_id=? AND status='received'").run(orderId);
  const printing = require('./printing');
  const tickets = d.prepare('SELECT id FROM kitchen_tickets WHERE order_id=?').all(orderId);
  for (const tk of tickets) printing.enqueueDoc(o.branch_id, 'kitchen', tk.id, { auto: true });
  const detail = orderDetail(orderId);
  rt.toKds(o.branch_id, 'kds:new', { order: detail });
  rt.toStaff(o.branch_id, 'order:new', { order: detail });
  rt.toSession(o.session_id, 'order:updated', { order: customerOrder(detail) });
}

function orderDetail(orderId) {
  const d = db.get();
  const o = d.prepare('SELECT o.*, t.code table_code, s.public_code FROM orders o JOIN table_sessions s ON s.id=o.session_id JOIN tables t ON t.id=s.table_id WHERE o.id=?').get(orderId);
  if (!o) throw err(404, 'order_not_found', 'ไม่พบออเดอร์');
  const items = d.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(orderId).map(itemOut);
  return { id: o.id, order_no: o.order_no, session_id: o.session_id, public_code: o.public_code, table_code: o.table_code, guest_label: o.guest_label, source: o.source, created_at: o.created_at, status: aggregateStatus(items.map((i) => i.status)), items };
}
function itemOut(i) {
  return { id: i.id, order_id: i.order_id, menu_item_id: i.menu_item_id, name: db.J(i.name, {}), qty: i.qty, options: db.J(i.options, []), note: i.note, unit_extra: i.unit_extra, guest_label: i.guest_label, station_id: i.station_id, ticket_id: i.ticket_id, status: i.status, status_at: i.status_at, created_at: i.created_at, cancel_reason: i.cancel_reason };
}
// Customer-safe projection
function customerOrder(o) {
  return { id: o.id, order_no: o.order_no, guest_label: o.guest_label, created_at: o.created_at, status: o.status, items: o.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, options: i.options, note: i.note, status: i.status, unit_extra: i.unit_extra, guest_label: i.guest_label })) };
}

function sessionOrders(sessionId) {
  const d = db.get();
  const ids = d.prepare('SELECT DISTINCT order_id FROM order_items WHERE session_id=? ORDER BY order_id DESC').all(sessionId).map((r) => r.order_id);
  return ids.map(orderDetail).map((o) => ({ ...o, items: o.items }));
}

const TRANSITIONS = {
  received: ['sent', 'preparing', 'cooking', 'ready', 'cancelled', 'unavailable'],
  sent: ['preparing', 'cooking', 'ready', 'served', 'cancelled', 'unavailable'],
  preparing: ['cooking', 'ready', 'served', 'cancelled', 'unavailable', 'sent'],
  cooking: ['ready', 'served', 'cancelled', 'unavailable', 'preparing'],
  ready: ['served', 'cooking', 'cancelled'],
  served: ['ready', 'cancelled'],
  cancelled: [], unavailable: [],
};

// Update item statuses (KDS / POS). Returns affected order details.
function updateItems(req, itemIds, status, { reason } = {}) {
  const d = db.get();
  if (!ITEM_STATUSES.includes(status)) throw err(400, 'invalid_status', 'สถานะไม่ถูกต้อง');
  if (!Array.isArray(itemIds) || !itemIds.length) throw err(400, 'items_required', 'ไม่ได้เลือกรายการ');
  const touchedOrders = new Set();
  let approver = null;
  d.transaction(() => {
    for (const id of itemIds) {
      const it = d.prepare('SELECT i.*, o.branch_id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=?').get(id);
      if (!it || it.branch_id !== req.branchId) throw err(404, 'item_not_found', 'ไม่พบรายการ');
      if (it.status === status) continue;
      if (!TRANSITIONS[it.status].includes(status)) throw err(409, 'invalid_transition', `เปลี่ยนสถานะจาก ${it.status} เป็น ${status} ไม่ได้`);
      if (status === 'cancelled' || status === 'unavailable') {
        const auth = require('../auth');
        if (!auth.has(req.staff, 'order.cancel') && !(status === 'unavailable' && auth.has(req.staff, 'kitchen.update'))) throw err(403, 'forbidden', 'ไม่มีสิทธิ์ยกเลิกรายการ');
        if (it.status === 'served' && approver == null) approver = auth.requireApproval(req, 'cancel_served_item', req.body && req.body.approval) || 0;
      }
      const t = now();
      d.prepare(`UPDATE order_items SET status=?, status_at=?, cancel_reason=COALESCE(?, cancel_reason), ready_at=CASE WHEN ?='ready' THEN ? ELSE ready_at END, served_at=CASE WHEN ?='served' THEN ? ELSE served_at END WHERE id=?`)
        .run(status, t, reason ? String(reason).slice(0, 200) : null, status, t, status, t, id);
      touchedOrders.add(it.order_id);
      if (it.ticket_id) refreshTicket(it.ticket_id);
      if (['cancelled', 'unavailable'].includes(status)) require('../auth').auditReq(req, `order_item.${status}`, 'order_item', id, { reason, from: it.status }, approver || null);
    }
  })();
  const out = [...touchedOrders].map(orderDetail);
  for (const o of out) {
    const branch = req.branchId;
    rt.toKds(branch, 'kds:update', { order: o });
    rt.toStaff(branch, 'order:updated', { order: o });
    rt.toSession(o.session_id, 'order:updated', { order: customerOrder(o) });
  }
  return out;
}

function refreshTicket(ticketId) {
  const d = db.get();
  const st = d.prepare('SELECT status FROM order_items WHERE ticket_id=?').all(ticketId).map((r) => r.status);
  const agg = aggregateStatus(st);
  const done = ['ready', 'served', 'cancelled', 'unavailable'].includes(agg);
  d.prepare('UPDATE kitchen_tickets SET status=?, done_at=CASE WHEN ? THEN COALESCE(done_at, ?) ELSE NULL END WHERE id=?').run(agg, done ? 1 : 0, now(), ticketId);
}

// KDS feed: open tickets for a branch (optionally one station), oldest first
function kdsTickets(branchId, { stationId, includeDone = false } = {}) {
  const d = db.get();
  const where = ['k.branch_id=?']; const args = [branchId];
  if (stationId) { where.push('k.station_id=?'); args.push(stationId); }
  if (!includeDone) where.push("k.status NOT IN ('ready','served','cancelled','unavailable')");
  else { where.push('k.created_at>?'); args.push(now() - 3 * 3600e3); }
  const rows = d.prepare(`SELECT k.*, o.order_no, o.created_at order_at, t.code table_code, s.public_code, ks.name station_name, ks.color station_color,
      (SELECT COUNT(*) FROM kitchen_tickets k2 WHERE k2.session_id=k.session_id AND k2.order_id<k.order_id) prev_count
    FROM kitchen_tickets k JOIN orders o ON o.id=k.order_id JOIN table_sessions s ON s.id=k.session_id JOIN tables t ON t.id=s.table_id
    LEFT JOIN kitchen_stations ks ON ks.id=k.station_id WHERE ${where.join(' AND ')} ORDER BY k.priority DESC, k.created_at LIMIT 200`).all(...args);
  return rows.map((k) => ({
    id: k.id, order_id: k.order_id, order_no: k.order_no, table_code: k.table_code, public_code: k.public_code, station_id: k.station_id, station_name: k.station_name, station_color: k.station_color,
    status: k.status, priority: k.priority, created_at: k.created_at, done_at: k.done_at, is_additional: k.prev_count > 0,
    items: d.prepare('SELECT * FROM order_items WHERE ticket_id=? ORDER BY id').all(k.id).map(itemOut),
  }));
}

module.exports = { ITEM_STATUSES, aggregateStatus, placeOrder, orderDetail, customerOrder, sessionOrders, updateItems, kdsTickets, refreshTicket, dispatchToKitchen };
