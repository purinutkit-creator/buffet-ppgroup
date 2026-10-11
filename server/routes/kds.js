'use strict';
// Kitchen Display System API
const express = require('express');
const db = require('../db');
const { err, now } = require('../lib/util');
const auth = require('../auth');
const orders = require('../services/orders');
const theme = require('../services/theme');
const { branchSettings } = require('../services/settings');
const rt = require('../realtime');

const r = express.Router();
const P = auth.requireStaff;

r.get('/bootstrap', P('kitchen.update'), (req, res) => {
  const s = branchSettings(req.branchId);
  res.json({ staff: auth.publicStaff(req.staff), stations: db.get().prepare('SELECT id, code, name, color FROM kitchen_stations WHERE branch_id=? AND active=1 ORDER BY sort, id').all(req.branchId),
    thresholds: s.kds_thresholds, sound: s.kds_sound, timezone: s.timezone, server_time: now(), theme: theme.activeTheme(req.branchId).settings.colors });
});
r.get('/tickets', P('kitchen.update'), (req, res) => {
  res.json({ tickets: orders.kdsTickets(req.branchId, { stationId: req.query.station ? Number(req.query.station) : null, includeDone: req.query.done === '1' }), server_time: now() });
});
r.post('/items', P('kitchen.update'), (req, res) => res.json({ orders: orders.updateItems(req, req.body.item_ids, req.body.status, { reason: req.body.reason }) }));
r.post('/tickets/:id/priority', P('kitchen.update'), (req, res) => {
  const t = db.get().prepare('SELECT * FROM kitchen_tickets WHERE id=? AND branch_id=?').get(req.params.id, req.branchId);
  if (!t) throw err(404, 'ticket_not_found', 'ไม่พบใบครัว');
  db.get().prepare('UPDATE kitchen_tickets SET priority=? WHERE id=?').run(req.body.urgent ? 1 : 0, t.id);
  rt.toKds(req.branchId, 'kds:update', { order: orders.orderDetail(t.order_id) });
  res.json({ ok: true });
});
module.exports = r;
