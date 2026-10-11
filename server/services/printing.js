'use strict';
// Print queue: routing documents to printers, rendering to ESC/POS, delivering to network printers directly,
// and handing jobs to the Local Print Bridge / browser print stations. Status: pending → printing → printed | failed.
const net = require('net');
const db = require('../db');
const { err, now, sha256, randomToken } = require('../lib/util');
const rt = require('../realtime');
const docs = require('../print/documents');
const { renderDoc, toMono } = require('../print/render');
const escpos = require('../print/escpos');

const MAX_ATTEMPTS = 3;
const STALE_MS = 60000;

function printerOut(p) {
  if (!p) return null;
  return { id: p.id, branch_id: p.branch_id, name: p.name, connection: p.connection, address: p.address, paper_width: p.paper_width, dots: p.dots, config: db.J(p.config, {}), status: p.status, last_seen_at: p.last_seen_at, last_error: p.last_error, active: !!p.active, has_bridge_key: !!p.bridge_key_hash };
}

function routes(branchId) {
  const rows = db.get().prepare('SELECT * FROM print_routes WHERE branch_id=?').all(branchId);
  return Object.keys(docs.DOC_TYPES).filter((k) => k !== 'test').map((k) => {
    const r = rows.find((x) => x.doc_type === k);
    return { doc_type: k, label: docs.DOC_TYPES[k], printer_id: r ? r.printer_id : null, copies: r ? r.copies : 1, auto: r ? !!r.auto : true };
  });
}

// Which printer prints a document. Kitchen tickets prefer the station's / menu item's printer.
function resolvePrinter(branchId, docType, refId) {
  const d = db.get();
  if (docType === 'kitchen') {
    const k = d.prepare('SELECT k.station_id FROM kitchen_tickets k WHERE k.id=?').get(refId);
    const itemPrinter = d.prepare('SELECT m.printer_id FROM order_items i JOIN menu_items m ON m.id=i.menu_item_id WHERE i.ticket_id=? AND m.printer_id IS NOT NULL LIMIT 1').get(refId);
    if (itemPrinter && itemPrinter.printer_id) return itemPrinter.printer_id;
    if (k && k.station_id) { const st = d.prepare('SELECT printer_id FROM kitchen_stations WHERE id=?').get(k.station_id); if (st && st.printer_id) return st.printer_id; }
  }
  const r = d.prepare('SELECT * FROM print_routes WHERE branch_id=? AND doc_type=?').get(branchId, docType);
  return r ? r.printer_id : null;
}

/**
 * Queue a document. opts.auto=true respects the route's "auto print" flag (used by workflows);
 * manual reprints always queue. Returns created job summaries (empty if not routed / auto disabled).
 */
function enqueueDoc(branchId, docType, refId, { auto = false, printerId, copies } = {}) {
  const d = db.get();
  const route = d.prepare('SELECT * FROM print_routes WHERE branch_id=? AND doc_type=?').get(branchId, docType);
  if (auto && route && !route.auto) return [];
  const pid = printerId || resolvePrinter(branchId, docType, refId);
  const printer = pid ? d.prepare('SELECT * FROM printers WHERE id=? AND branch_id=? AND active=1').get(pid, branchId) : null;
  if (!printer) {
    if (auto) return []; // nothing configured — workflow continues; UI shows "no printer assigned"
    throw err(409, 'no_printer', 'ยังไม่ได้กำหนดเครื่องพิมพ์สำหรับเอกสารนี้');
  }
  let data;
  try { data = docs.snapshot(docType, refId, branchId); } catch (e) { if (auto) { console.error('[print] snapshot failed', docType, refId, e.message); return []; } throw e; }
  const n = Math.max(1, Math.min(5, copies || (route ? route.copies : 1)));
  const r = d.prepare('INSERT INTO print_jobs(branch_id, printer_id, doc_type, ref_id, payload, copies, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(branchId, printer.id, docType, typeof refId === 'number' || typeof refId === 'bigint' ? Number(refId) : null, JSON.stringify({ data }), n, 'pending', now(), now());
  const job = jobOut(d.prepare('SELECT * FROM print_jobs WHERE id=?').get(r.lastInsertRowid));
  rt.toStaff(branchId, 'print:job', { job });
  if (printer.connection === 'browser') rt.toPrinters(branchId, 'print:available', { printer_id: printer.id });
  kick();
  return [job];
}

function jobOut(j) {
  return { id: j.id, branch_id: j.branch_id, printer_id: j.printer_id, doc_type: j.doc_type, doc_label: docs.DOC_TYPES[j.doc_type], ref_id: j.ref_id, copies: j.copies, status: j.status, attempts: j.attempts, error: j.error, claimed_by: j.claimed_by, created_at: j.created_at, updated_at: j.updated_at, printed_at: j.printed_at };
}

async function renderJob(job, printer, opts) {
  const doc = docs.buildDoc(job, printer, opts);
  return renderDoc(doc);
}
async function jobBytes(job, printer) {
  const canvas = await renderJob(job, printer);
  const cfg = db.J(printer.config, {});
  return escpos.build(toMono(canvas), { cut: cfg.cut !== false, beep: !!cfg.beep && job.doc_type === 'kitchen', drawer: !!cfg.drawer && job.doc_type === 'receipt', copies: job.copies });
}
async function jobPng(job, printer) { return (await renderJob(job, printer)).toBuffer('image/png'); }

function setStatus(jobId, status, error = null, claimedBy = undefined) {
  const d = db.get();
  d.prepare(`UPDATE print_jobs SET status=?, error=?, updated_at=?, printed_at=CASE WHEN ?='printed' THEN ? ELSE printed_at END${claimedBy !== undefined ? ', claimed_by=?' : ''} WHERE id=?`)
    .run(...[status, error, now(), status, now(), ...(claimedBy !== undefined ? [claimedBy] : []), jobId]);
  const j = d.prepare('SELECT * FROM print_jobs WHERE id=?').get(jobId);
  rt.toStaff(j.branch_id, 'print:job', { job: jobOut(j) });
  return j;
}

function markPrinter(printerId, status, error = null) {
  db.get().prepare('UPDATE printers SET status=?, last_error=?, last_seen_at=CASE WHEN ?=\'online\' THEN ? ELSE last_seen_at END WHERE id=?').run(status, error, status, now(), printerId);
}

// Raw TCP (port 9100 / JetDirect) delivery
function sendTcp(address, bytes, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = String(address || '').split(':');
    const port = Number(portStr || 9100);
    if (!host) return reject(new Error('ไม่ได้ระบุ IP เครื่องพิมพ์'));
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (e) => { if (done) return; done = true; sock.destroy(); e ? reject(e) : resolve(); };
    sock.setTimeout(timeout, () => finish(new Error(`หมดเวลาเชื่อมต่อ ${host}:${port}`)));
    sock.on('error', (e) => finish(new Error(`เชื่อมต่อ ${host}:${port} ไม่สำเร็จ: ${e.code || e.message}`)));
    sock.on('connect', () => sock.end(bytes, () => setTimeout(() => finish(), 150)));
  });
}
function probeTcp(address, timeout = 3000) {
  return new Promise((resolve) => {
    const [host, portStr] = String(address || '').split(':');
    if (!host) return resolve({ ok: false, error: 'ไม่ได้ระบุ IP' });
    const t0 = now();
    const sock = net.createConnection({ host, port: Number(portStr || 9100) });
    sock.setTimeout(timeout, () => { sock.destroy(); resolve({ ok: false, error: 'หมดเวลาเชื่อมต่อ' }); });
    sock.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    sock.on('connect', () => { sock.destroy(); resolve({ ok: true, latency_ms: now() - t0 }); });
  });
}

// ---- dispatcher for network printers (one job at a time per printer) ----
let timer = null, running = false;
const busy = new Set();
function kick() { if (timer) setImmediate(tick); }
async function tick() {
  if (running) return; running = true;
  try {
    const d = db.get();
    // requeue stale claims
    d.prepare("UPDATE print_jobs SET status='pending', claimed_by=NULL WHERE status='printing' AND claimed_at<? AND attempts<?").run(now() - STALE_MS, MAX_ATTEMPTS);
    const jobs = d.prepare(`SELECT j.* FROM print_jobs j JOIN printers p ON p.id=j.printer_id WHERE j.status='pending' AND p.connection='network' AND p.active=1 ORDER BY j.id LIMIT 20`).all();
    for (const job of jobs) {
      if (busy.has(job.printer_id)) continue;
      busy.add(job.printer_id);
      const claimed = d.prepare("UPDATE print_jobs SET status='printing', attempts=attempts+1, claimed_by='server', claimed_at=?, updated_at=? WHERE id=? AND status='pending'").run(now(), now(), job.id).changes;
      if (!claimed) { busy.delete(job.printer_id); continue; }
      const printer = d.prepare('SELECT * FROM printers WHERE id=?').get(job.printer_id);
      deliver(job, printer).finally(() => busy.delete(job.printer_id));
    }
  } catch (e) { console.error('[print] dispatcher', e); } finally { running = false; }
}
async function deliver(job, printer) {
  try {
    rt.toStaff(job.branch_id, 'print:job', { job: { ...jobOut(job), status: 'printing' } });
    const bytes = await jobBytes(job, printer);
    await sendTcp(printer.address, bytes);
    setStatus(job.id, 'printed');
    markPrinter(printer.id, 'online');
  } catch (e) {
    const j = db.get().prepare('SELECT attempts FROM print_jobs WHERE id=?').get(job.id);
    const final = j.attempts >= MAX_ATTEMPTS;
    setStatus(job.id, final ? 'failed' : 'pending', e.message);
    markPrinter(printer.id, 'offline', e.message);
    if (!final) setTimeout(kick, 2000 * j.attempts);
  }
}
function start() { if (!timer) timer = setInterval(tick, 1500); }
function stop() { if (timer) clearInterval(timer); timer = null; }

function retry(branchId, jobId) {
  const r = db.get().prepare("UPDATE print_jobs SET status='pending', attempts=0, error=NULL, claimed_by=NULL, updated_at=? WHERE id=? AND branch_id=? AND status IN ('failed','printed','pending')").run(now(), jobId, branchId);
  if (!r.changes) throw err(404, 'job_not_found', 'ไม่พบงานพิมพ์');
  const j = db.get().prepare('SELECT j.*, p.connection FROM print_jobs j JOIN printers p ON p.id=j.printer_id WHERE j.id=?').get(jobId);
  if (j.connection === 'browser') rt.toPrinters(branchId, 'print:available', { printer_id: j.printer_id });
  kick();
  return jobOut(j);
}

// ---- bridge / browser station claiming ----
function newBridgeKey(printerId) {
  const key = 'pb_' + randomToken(24);
  db.get().prepare('UPDATE printers SET bridge_key_hash=? WHERE id=?').run(sha256(key), printerId);
  return key;
}
function printerByBridgeKey(key) {
  if (!key) return null;
  return db.get().prepare("SELECT * FROM printers WHERE bridge_key_hash=? AND active=1 AND connection='bridge'").get(sha256(key));
}
// Claim the next pending job for a printer (bridge or browser station). Returns job + ESC/POS bytes (base64).
async function claimNext(printer, claimer) {
  const d = db.get();
  d.prepare("UPDATE print_jobs SET status='pending', claimed_by=NULL WHERE printer_id=? AND status='printing' AND claimed_at<?").run(printer.id, now() - STALE_MS);
  markPrinter(printer.id, 'online');
  const job = d.prepare("SELECT * FROM print_jobs WHERE printer_id=? AND status='pending' ORDER BY id LIMIT 1").get(printer.id);
  if (!job) return null;
  const ok = d.prepare("UPDATE print_jobs SET status='printing', attempts=attempts+1, claimed_by=?, claimed_at=?, updated_at=? WHERE id=? AND status='pending'").run(String(claimer).slice(0, 60), now(), now(), job.id).changes;
  if (!ok) return null;
  rt.toStaff(job.branch_id, 'print:job', { job: { ...jobOut(job), status: 'printing' } });
  try {
    const bytes = await jobBytes(job, printer);
    return { job: jobOut(job), data: bytes.toString('base64'), target: printer.address };
  } catch (e) { setStatus(job.id, 'failed', 'render: ' + e.message); return null; }
}
function report(printer, jobId, ok, error) {
  const j = db.get().prepare('SELECT * FROM print_jobs WHERE id=? AND printer_id=?').get(jobId, printer.id);
  if (!j) throw err(404, 'job_not_found', 'ไม่พบงานพิมพ์');
  if (ok) { setStatus(j.id, 'printed'); markPrinter(printer.id, 'online'); }
  else { setStatus(j.id, j.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', String(error || 'error').slice(0, 300)); markPrinter(printer.id, 'error', String(error || '').slice(0, 300)); }
  return true;
}

module.exports = { printerOut, routes, enqueueDoc, jobOut, jobBytes, jobPng, renderJob, sendTcp, probeTcp, start, stop, kick, retry, newBridgeKey, printerByBridgeKey, claimNext, report, setStatus, markPrinter };
