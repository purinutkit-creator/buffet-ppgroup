'use strict';
// Staff call requests from customers (bell button + admin-defined quick buttons).
const db = require('../db');
const { err, now, tr } = require('../lib/util');
const { branchSettings } = require('./settings');
const rt = require('../realtime');

const OPEN = ['pending', 'accepted', 'in_progress'];

function callTypes(branchId, { all = false } = {}) {
  return db.get().prepare(`SELECT * FROM staff_call_types WHERE (branch_id IS NULL OR branch_id=?) ${all ? '' : 'AND active=1'} ORDER BY sort, id`).all(branchId)
    .map((c) => ({ id: c.id, name: db.J(c.name, {}), icon: c.icon, color: c.color, image: c.image_asset_id ? `/media/${c.image_asset_id}` : null, image_asset_id: c.image_asset_id, sort: c.sort, active: !!c.active, is_bill: !!c.is_bill, branch_id: c.branch_id }));
}

function callOut(c) {
  return { id: c.id, session_id: c.session_id, table_id: c.table_id, table_code: c.table_code, type_id: c.type_id, label: db.J(c.label, {}), note: c.note, guest_label: c.guest_label, status: c.status, created_at: c.created_at, accepted_at: c.accepted_at, accepted_by: c.accepted_by, accepted_by_name: c.accepted_name, done_at: c.done_at, done_by: c.done_by };
}
function getCall(id) {
  return db.get().prepare('SELECT c.*, t.code table_code, s1.name accepted_name FROM staff_calls c JOIN tables t ON t.id=c.table_id LEFT JOIN staff s1 ON s1.id=c.accepted_by WHERE c.id=?').get(id);
}

function createCall(session, { type_id, note, guest_label }) {
  const d = db.get();
  const settings = branchSettings(session.branch_id);
  let label = { th: 'เรียกพนักงาน', en: 'Call staff', zh: '呼叫服务员' };
  let typeId = null;
  if (type_id) {
    const t = d.prepare('SELECT * FROM staff_call_types WHERE id=? AND active=1 AND (branch_id IS NULL OR branch_id=?)').get(type_id, session.branch_id);
    if (!t) throw err(400, 'invalid_call_type', 'ประเภทคำขอไม่ถูกต้อง');
    label = db.J(t.name, {}); typeId = t.id;
  }
  // Anti-spam: same type, same session within cooldown → reject; also cap open requests
  const cooldown = settings.call_cooldown_sec * 1000;
  const recent = d.prepare(`SELECT * FROM staff_calls WHERE session_id=? AND COALESCE(type_id,0)=? AND created_at>? ORDER BY id DESC LIMIT 1`).get(session.id, typeId || 0, now() - cooldown);
  if (recent && OPEN.includes(recent.status)) throw err(429, 'call_cooldown', 'ได้แจ้งพนักงานแล้ว กรุณารอสักครู่', { retry_after_ms: recent.created_at + cooldown - now(), call: callOut(getCall(recent.id)) });
  const openCount = d.prepare(`SELECT COUNT(*) c FROM staff_calls WHERE session_id=? AND status IN ('pending','accepted','in_progress')`).get(session.id).c;
  if (openCount >= 5) throw err(429, 'too_many_calls', 'มีคำขอที่รอดำเนินการหลายรายการแล้ว');
  const r = d.prepare('INSERT INTO staff_calls(branch_id, session_id, table_id, type_id, label, note, guest_label, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(session.branch_id, session.id, session.table_id, typeId, JSON.stringify(label), note ? String(note).slice(0, 200) : null, guest_label || null, 'pending', now());
  const c = callOut(getCall(r.lastInsertRowid));
  rt.toStaff(session.branch_id, 'call:new', { call: c });
  rt.toSession(session.id, 'call:updated', { call: c });
  return c;
}

const CALL_TRANSITIONS = { pending: ['accepted', 'in_progress', 'done', 'cancelled'], accepted: ['in_progress', 'done', 'cancelled'], in_progress: ['done', 'cancelled'], done: [], cancelled: [] };

function updateCall(req, id, status) {
  const d = db.get();
  const c = d.prepare('SELECT * FROM staff_calls WHERE id=? AND branch_id=?').get(id, req.branchId);
  if (!c) throw err(404, 'call_not_found', 'ไม่พบคำขอ');
  if (!CALL_TRANSITIONS[c.status].includes(status)) throw err(409, 'invalid_transition', 'เปลี่ยนสถานะไม่ได้');
  const t = now();
  if (status === 'accepted' || status === 'in_progress') d.prepare('UPDATE staff_calls SET status=?, accepted_at=COALESCE(accepted_at,?), accepted_by=COALESCE(accepted_by,?) WHERE id=?').run(status, t, req.staff.id, id);
  else d.prepare('UPDATE staff_calls SET status=?, done_at=?, done_by=?, accepted_at=COALESCE(accepted_at,?), accepted_by=COALESCE(accepted_by,?) WHERE id=?').run(status, t, req.staff.id, t, req.staff.id, id);
  const out = callOut(getCall(id));
  rt.toStaff(req.branchId, 'call:updated', { call: out });
  rt.toSession(c.session_id, 'call:updated', { call: out });
  return out;
}

function openCalls(branchId) {
  return db.get().prepare(`SELECT c.*, t.code table_code, s1.name accepted_name FROM staff_calls c JOIN tables t ON t.id=c.table_id LEFT JOIN staff s1 ON s1.id=c.accepted_by
    WHERE c.branch_id=? AND (c.status IN ('pending','accepted','in_progress') OR c.done_at>?) ORDER BY c.created_at`).all(branchId, now() - 30 * 60000).map(callOut);
}
function sessionCalls(sessionId) {
  return db.get().prepare(`SELECT c.*, t.code table_code, NULL accepted_name FROM staff_calls c JOIN tables t ON t.id=c.table_id WHERE c.session_id=? ORDER BY c.id DESC LIMIT 20`).all(sessionId)
    .map(callOut).map(({ accepted_by, done_by, ...x }) => x);
}

module.exports = { callTypes, createCall, updateCall, openCalls, sessionCalls };
