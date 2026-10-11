#!/usr/bin/env node
'use strict';
/*
 * Local Print Bridge — runs on a computer next to the printer and forwards ESC/POS jobs from the server.
 * Use it for printers the server cannot reach directly (USB, serial, CUPS-shared, or LAN printers on a different network).
 *
 *   node print-bridge/bridge.js --server https://pos.example.com --key pb_xxx [--target <target>]
 *
 * Targets (default: the "address" configured for the printer in Admin):
 *   tcp://192.168.1.50:9100     raw TCP / JetDirect
 *   file:/dev/usb/lp0           USB printer device on Linux (or any writable device/file)
 *   file:COM3  / file:\\.\COM3  serial port on Windows (configure baud rate with `mode` first)
 *   cups:PrinterName            CUPS queue (macOS/Linux) via `lp -o raw`
 *   win:PrinterName             Windows shared printer via `copy /b` to \\localhost\PrinterName
 *
 * Only Node.js ≥ 18 is required (no extra packages). Ctrl+C to stop.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : process.env[`BRIDGE_${n.toUpperCase()}`] || d; };
const server = (arg('server', 'http://localhost:3000')).replace(/\/$/, '');
const key = arg('key');
const forcedTarget = arg('target');
const interval = Number(arg('interval', 2000));
if (!key) { console.error('ต้องระบุ --key (สร้างได้ที่ Admin › เครื่องพิมพ์ › Print Bridge Key)'); process.exit(1); }

const headers = { 'x-bridge-key': key, 'content-type': 'application/json' };
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function call(method, url, body) {
  const r = await fetch(server + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `HTTP ${r.status}`);
  return data;
}

function sendTcp(addr, bytes) {
  return new Promise((resolve, reject) => {
    const [host, port] = addr.split(':');
    const s = net.createConnection({ host, port: Number(port || 9100) });
    s.setTimeout(8000, () => { s.destroy(); reject(new Error('timeout')); });
    s.on('error', reject);
    s.on('connect', () => s.end(bytes, () => setTimeout(() => { s.destroy(); resolve(); }, 150)));
  });
}
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'], shell: false });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
    if (input) p.stdin.end(input);
  });
}
async function deliver(target, bytes) {
  if (!target) throw new Error('ไม่ได้กำหนดปลายทางเครื่องพิมพ์ (--target หรือ address ใน Admin)');
  if (target.startsWith('tcp://')) return sendTcp(target.slice(6), bytes);
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(target)) return sendTcp(target, bytes);
  if (target.startsWith('file:')) { const f = target.slice(5); const fd = fs.openSync(f, 'w'); try { fs.writeSync(fd, bytes); } finally { fs.closeSync(fd); } return; }
  if (target.startsWith('cups:')) return run('lp', ['-d', target.slice(5), '-o', 'raw'], bytes);
  if (target.startsWith('win:')) {
    const tmp = path.join(os.tmpdir(), `bf-${Date.now()}.bin`); fs.writeFileSync(tmp, bytes);
    try { await run('cmd', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${target.slice(4)}`]); } finally { fs.unlinkSync(tmp); }
    return;
  }
  throw new Error(`ไม่รู้จักปลายทาง: ${target}`);
}

let stopping = false;
async function loop() {
  try {
    const hello = await call('GET', '/api/print/bridge/hello');
    log(`เชื่อมต่อเซิร์ฟเวอร์แล้ว • เครื่องพิมพ์: ${hello.printer.name} (${hello.printer.paper_width}mm) • ปลายทาง: ${forcedTarget || hello.printer.address || '-'}`);
  } catch (e) { log('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ:', e.message); }
  while (!stopping) {
    try {
      const { job } = await call('POST', '/api/print/bridge/claim');
      if (job) {
        const bytes = Buffer.from(job.data, 'base64');
        try {
          await deliver(forcedTarget || job.target, bytes);
          await call('POST', `/api/print/bridge/jobs/${job.job.id}/result`, { ok: true });
          log(`✔ พิมพ์ ${job.job.doc_label} #${job.job.id} (${bytes.length} bytes)`);
          continue; // check for more immediately
        } catch (e) {
          log(`✘ ${job.job.doc_label} #${job.job.id}: ${e.message}`);
          await call('POST', `/api/print/bridge/jobs/${job.job.id}/result`, { ok: false, error: e.message }).catch(() => {});
        }
      }
    } catch (e) { log('ผิดพลาด:', e.message); }
    await new Promise((r) => setTimeout(r, interval));
  }
}
process.on('SIGINT', () => { stopping = true; log('หยุดการทำงาน'); setTimeout(() => process.exit(0), 300); });
loop();
