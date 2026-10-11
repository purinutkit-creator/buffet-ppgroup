'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { rateLimit } = require('../lib/ratelimit');

const r = express.Router();
r.get('/branches', (req, res) => {
  res.json({ branches: db.get().prepare('SELECT id, code, name FROM branches WHERE active=1 ORDER BY id').all().map((b) => ({ ...b, name: db.J(b.name, {}) })), setup_required: !db.get().prepare('SELECT 1 FROM staff LIMIT 1').get() });
});
r.post('/login', rateLimit({ windowMs: 300000, max: 20 }), (req, res) => {
  require('../lib/baseurl').remember(req);
  res.json(auth.login(req.body.code, req.body.pin, req.body.branch_id ? Number(req.body.branch_id) : null, req.get('user-agent')));
});
r.post('/logout', auth.requireStaff(), (req, res) => { auth.logout(auth.bearer(req)); res.json({ ok: true }); });
r.get('/me', auth.requireStaff(), (req, res) => res.json({ staff: auth.publicStaff(req.staff), branch_id: req.branchId }));
// Switch branch (new token for another permitted branch)
r.post('/switch-branch', auth.requireStaff(), (req, res) => {
  const b = Number(req.body.branch_id);
  if (!auth.canAccessBranch(req.staff, b)) throw Object.assign(new Error('forbidden'), { status: 403, code: 'branch_forbidden' });
  const token = require('../lib/util').randomToken(32);
  db.get().prepare('INSERT INTO staff_tokens(token_hash, staff_id, branch_id, device, created_at, expires_at) VALUES(?,?,?,?,?,?)').run(require('../lib/util').sha256(token), req.staff.id, b, 'switch', Date.now(), Date.now() + require('../config').staffTokenHours * 3600e3);
  auth.logout(auth.bearer(req));
  res.json({ token, branch_id: b, staff: auth.publicStaff(req.staff) });
});
module.exports = r;
