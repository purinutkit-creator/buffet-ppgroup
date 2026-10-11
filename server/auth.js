'use strict';
// Staff authentication (employee code + PIN), permission checks, manager approval and audit logging.
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { err, now, randomToken, sha256 } = require('./lib/util');

const PERMISSIONS = {
  'table.open': 'เปิดโต๊ะ',
  'table.close': 'ปิดโต๊ะ / รับชำระเงิน',
  'table.move': 'ย้าย / รวม / แยกโต๊ะ',
  'table.extend': 'ต่อเวลา',
  'table.package': 'เปลี่ยนแพ็กเกจ / เพิ่มลูกค้า',
  'table.qr': 'พิมพ์ซ้ำ / สร้าง QR ใหม่',
  'order.create': 'สั่งอาหารแทนลูกค้า',
  'order.cancel': 'ยกเลิกรายการอาหาร',
  'kitchen.update': 'อัปเดตสถานะครัว',
  'call.handle': 'รับงานเรียกพนักงาน',
  'discount.apply': 'ให้ส่วนลด',
  'payment.refund': 'คืนเงิน',
  'points.adjust': 'ปรับคะแนนสมาชิก',
  'member.manage': 'จัดการสมาชิก',
  'menu.manage': 'จัดการเมนูและแพ็กเกจ',
  'settings.manage': 'ตั้งค่าร้าน / ธีม / เครื่องพิมพ์',
  'staff.manage': 'จัดการพนักงานและสิทธิ์',
  'report.view': 'ดูรายงาน',
  'audit.view': 'ดู Audit Log',
  'approve': 'อนุมัติรายการสำคัญ (Manager Approval)',
  'backup.manage': 'สำรอง / กู้คืนข้อมูล',
};
const ALL = Object.keys(PERMISSIONS);

const DEFAULT_ROLES = [
  { code: 'owner', name: 'Owner', permissions: ALL },
  { code: 'admin', name: 'Admin', permissions: ALL },
  { code: 'manager', name: 'Manager', permissions: ALL.filter((p) => !['staff.manage', 'backup.manage'].includes(p)) },
  { code: 'supervisor', name: 'Supervisor', permissions: ['table.open', 'table.close', 'table.move', 'table.extend', 'table.package', 'table.qr', 'order.create', 'order.cancel', 'kitchen.update', 'call.handle', 'discount.apply', 'member.manage', 'report.view', 'approve'] },
  { code: 'cashier', name: 'Cashier', permissions: ['table.open', 'table.close', 'table.extend', 'table.qr', 'order.create', 'call.handle', 'member.manage', 'discount.apply'] },
  { code: 'waiter', name: 'Waiter', permissions: ['table.open', 'table.qr', 'order.create', 'call.handle', 'member.manage'] },
  { code: 'kitchen', name: 'Kitchen', permissions: ['kitchen.update'] },
];

const hashPin = (pin) => bcrypt.hashSync(String(pin), 10);
function validPin(pin) { return /^\d{4,8}$/.test(String(pin || '')); }

function loadStaff(id) {
  const s = db.get().prepare(`SELECT s.*, r.code role_code, r.name role_name, r.permissions FROM staff s JOIN roles r ON r.id=s.role_id WHERE s.id=?`).get(id);
  if (!s) return null;
  return { id: s.id, code: s.code, name: s.name, role: s.role_code, role_name: s.role_name, restaurant_id: s.restaurant_id, active: !!s.active,
    permissions: db.J(s.permissions, []), branch_ids: db.J(s.branch_ids, []), pin_hash: s.pin_hash, locked_until: s.locked_until, failed_attempts: s.failed_attempts };
}

function verifyCredentials(code, pin) {
  const d = db.get();
  const row = d.prepare('SELECT id FROM staff WHERE code=? AND active=1').get(String(code || '').trim());
  if (!row) throw err(401, 'invalid_credentials', 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง');
  const s = loadStaff(row.id);
  if (s.locked_until && s.locked_until > now()) throw err(423, 'locked', 'บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ภายหลัง');
  if (!bcrypt.compareSync(String(pin || ''), s.pin_hash)) {
    const fails = s.failed_attempts + 1;
    d.prepare('UPDATE staff SET failed_attempts=?, locked_until=? WHERE id=?').run(fails >= 5 ? 0 : fails, fails >= 5 ? now() + 5 * 60000 : null, s.id);
    throw err(401, 'invalid_credentials', 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง');
  }
  d.prepare('UPDATE staff SET failed_attempts=0, locked_until=NULL WHERE id=?').run(s.id);
  return s;
}

function canAccessBranch(staff, branchId) {
  return !staff.branch_ids.length || staff.branch_ids.includes(Number(branchId));
}

function login(code, pin, branchId, device) {
  const s = verifyCredentials(code, pin);
  const d = db.get();
  if (!branchId) {
    const b = d.prepare('SELECT id FROM branches WHERE active=1 ORDER BY id').all().find((x) => canAccessBranch(s, x.id));
    branchId = b && b.id;
  }
  if (!branchId || !d.prepare('SELECT 1 FROM branches WHERE id=? AND active=1').get(branchId)) throw err(400, 'invalid_branch', 'ไม่พบสาขา');
  if (!canAccessBranch(s, branchId)) throw err(403, 'branch_forbidden', 'ไม่มีสิทธิ์เข้าใช้งานสาขานี้');
  const token = randomToken(32);
  d.prepare('INSERT INTO staff_tokens(token_hash, staff_id, branch_id, device, created_at, expires_at) VALUES(?,?,?,?,?,?)')
    .run(sha256(token), s.id, branchId, String(device || '').slice(0, 120), now(), now() + config.staffTokenHours * 3600e3);
  d.prepare('UPDATE staff SET last_login_at=? WHERE id=?').run(now(), s.id);
  audit({ branch_id: branchId, staff_id: s.id, action: 'staff.login', entity: 'staff', entity_id: s.id });
  return { token, staff: publicStaff(s), branch_id: Number(branchId) };
}

function publicStaff(s) { return { id: s.id, code: s.code, name: s.name, role: s.role, role_name: s.role_name, permissions: s.permissions, branch_ids: s.branch_ids }; }

function resolveToken(token) {
  if (!token) return null;
  const t = db.get().prepare('SELECT * FROM staff_tokens WHERE token_hash=? AND revoked=0').get(sha256(token));
  if (!t || t.expires_at < now()) return null;
  const s = loadStaff(t.staff_id);
  if (!s || !s.active) return null;
  return { staff: s, branch_id: t.branch_id };
}

function logout(token) { db.get().prepare('UPDATE staff_tokens SET revoked=1 WHERE token_hash=?').run(sha256(token)); }

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

// Express middleware: requires a staff session; optional permission list (any-of)
function requireStaff(...perms) {
  return (req, res, next) => {
    const auth = resolveToken(bearer(req));
    if (!auth) return next(err(401, 'unauthenticated', 'กรุณาเข้าสู่ระบบ'));
    req.staff = auth.staff; req.branchId = auth.branch_id;
    if (perms.length && !perms.some((p) => auth.staff.permissions.includes(p))) return next(err(403, 'forbidden', 'ไม่มีสิทธิ์ดำเนินการนี้', { required: perms }));
    next();
  };
}
const has = (staff, perm) => staff.permissions.includes(perm);
function assertPerm(staff, perm) { if (!has(staff, perm)) throw err(403, 'forbidden', 'ไม่มีสิทธิ์ดำเนินการนี้', { required: [perm] }); }

// Manager approval: a second staff member with the "approve" permission enters code+PIN.
// The approval object is {code, pin}. Returns approver id, throws if missing/invalid.
function requireApproval(req, action, approval) {
  const settings = require('./services/settings').branchSettings(req.branchId);
  const needed = settings.require_manager_approval.includes(action);
  if (!needed) return null;
  if (!approval || !approval.code) throw err(428, 'approval_required', 'ต้องได้รับการอนุมัติจากผู้จัดการ', { action });
  const a = verifyCredentials(approval.code, approval.pin);
  if (!a.permissions.includes('approve')) throw err(403, 'approver_forbidden', 'ผู้อนุมัติไม่มีสิทธิ์อนุมัติ');
  if (!canAccessBranch(a, req.branchId)) throw err(403, 'approver_forbidden', 'ผู้อนุมัติไม่มีสิทธิ์ในสาขานี้');
  return a.id;
}

function audit({ branch_id = null, staff_id = null, approver_id = null, action, entity = null, entity_id = null, data = null, ip = null }) {
  db.get().prepare('INSERT INTO audit_logs(branch_id, staff_id, approver_id, action, entity, entity_id, data, ip, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(branch_id, staff_id, approver_id, action, entity, entity_id, data == null ? null : JSON.stringify(data), ip, now());
}
// Convenience: audit from a request
const auditReq = (req, action, entity, entity_id, data, approver_id) =>
  audit({ branch_id: req.branchId, staff_id: req.staff && req.staff.id, approver_id, action, entity, entity_id, data, ip: req.ip });

module.exports = { PERMISSIONS, ALL, DEFAULT_ROLES, hashPin, validPin, verifyCredentials, login, logout, resolveToken, bearer, requireStaff, has, assertPerm, requireApproval, audit, auditReq, publicStaff, canAccessBranch, loadStaff };
