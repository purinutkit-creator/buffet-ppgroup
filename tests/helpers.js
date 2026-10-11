'use strict';
// Test harness: isolated data dir, real HTTP server, a fake LAN thermal printer (TCP 9100) and socket.io clients.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buffet-test-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.OTP_MODE = 'dev';
process.env.AUTO_BACKUP_HOURS = '0';

const server = require('../server/index');
const { setup } = require('../server/bootstrap');
const { io } = require('socket.io-client');

async function startAll() {
  setup({ restaurantName: { th: 'Papper international buffet', en: 'Papper international buffet' }, branchCode: 'BS', branchName: { th: 'Papper international buffet Bangsaen' }, ownerCode: 'OWNER', ownerPin: '123456', taxId: '0205565018968', phone: '061-441-1308' });
  const srv = await server.start(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  // fake printer
  const received = [];
  const printer = net.createServer((sock) => { const chunks = []; sock.on('data', (c) => chunks.push(c)); sock.on('end', () => received.push(Buffer.concat(chunks))); });
  await new Promise((r) => printer.listen(0, '127.0.0.1', r));
  return { srv, base, printer, printerAddr: `127.0.0.1:${printer.address().port}`, received, dir };
}

function client(base) {
  let token = null;
  const call = async (method, url, body, extraHeaders = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
  return {
    setToken: (t) => { token = t; }, get token() { return token; },
    get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b ?? {}, h), put: (u, b) => call('PUT', u, b ?? {}), del: (u) => call('DELETE', u), patch: (u, b) => call('PATCH', u, b),
  };
}

function socket(base, auth) {
  const s = io(base, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
  const events = [];
  s.onAny((ev, payload) => events.push({ ev, payload }));
  const waitFor = (ev, pred = () => true, timeout = 4000) => new Promise((resolve, reject) => {
    const found = events.find((e) => e.ev === ev && pred(e.payload));
    if (found) return resolve(found.payload);
    const t = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); resolve(p); } };
    s.on(ev, h);
  });
  const connected = new Promise((resolve, reject) => { s.on('connect', resolve); s.on('connect_error', reject); });
  return { s, events, waitFor, connected, close: () => s.close() };
}

const until = async (fn, timeout = 6000, step = 100) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('until: timeout'); await new Promise((r) => setTimeout(r, step)); }
};
const key = () => 'k' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

module.exports = { startAll, client, socket, until, key, server };
