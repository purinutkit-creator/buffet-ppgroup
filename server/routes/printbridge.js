'use strict';
// Endpoints for the Local Print Bridge (bridge key) and browser print stations (staff token).
const express = require('express');
const db = require('../db');
const { err } = require('../lib/util');
const auth = require('../auth');
const printing = require('../services/printing');

const r = express.Router();

// ---- Local Print Bridge (USB / serial / CUPS / LAN from a shop computer) ----
function bridge(req) {
  const key = req.get('x-bridge-key');
  const p = printing.printerByBridgeKey(key);
  if (!p) throw err(401, 'invalid_bridge_key', 'Bridge key ไม่ถูกต้อง');
  return p;
}
r.get('/bridge/hello', (req, res) => { const p = bridge(req); printing.markPrinter(p.id, 'online'); res.json({ printer: printing.printerOut(p) }); });
r.post('/bridge/claim', async (req, res) => { const p = bridge(req); res.json({ job: await printing.claimNext(p, `bridge:${req.ip}`) }); });
r.post('/bridge/jobs/:id/result', (req, res) => { const p = bridge(req); printing.report(p, Number(req.params.id), !!req.body.ok, req.body.error); res.json({ ok: true }); });

// ---- Browser print station (WebUSB / Web Serial / Web Bluetooth in Chrome) ----
const station = auth.requireStaff('settings.manage', 'table.close', 'kitchen.update');
function browserPrinter(req) {
  const p = db.get().prepare("SELECT * FROM printers WHERE id=? AND branch_id=? AND connection='browser' AND active=1").get(req.params.pid, req.branchId);
  if (!p) throw err(404, 'printer_not_found', 'ไม่พบเครื่องพิมพ์ (ต้องเป็นชนิด Browser)');
  return p;
}
r.get('/station/printers', station, (req, res) => {
  res.json({ printers: db.get().prepare("SELECT * FROM printers WHERE branch_id=? AND connection='browser' AND active=1").all(req.branchId).map(printing.printerOut) });
});
r.post('/station/:pid/claim', station, async (req, res) => res.json({ job: await printing.claimNext(browserPrinter(req), `browser:${req.staff.code}`) }));
r.post('/station/:pid/jobs/:id/result', station, (req, res) => { printing.report(browserPrinter(req), Number(req.params.id), !!req.body.ok, req.body.error); res.json({ ok: true }); });
r.post('/station/:pid/status', station, (req, res) => { const p = browserPrinter(req); printing.markPrinter(p.id, req.body.online ? 'online' : 'offline', req.body.error || null); res.json({ ok: true }); });

module.exports = r;
