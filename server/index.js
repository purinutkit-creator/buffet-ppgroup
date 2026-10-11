'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db');
const realtime = require('./realtime');
const { AppError } = require('./lib/util');

function createApp() {
  db.open();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN', 'Permissions-Policy': 'camera=(self), usb=(self), serial=(self), bluetooth=(self)' });
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // API
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/c', require('./routes/customer'));
  app.use('/api/pos', require('./routes/pos'));
  app.use('/api/kds', require('./routes/kds'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/print', require('./routes/printbridge'));
  app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

  // Theme CSS (public — values are validated colors/sizes/font names)
  app.get('/theme.css', (req, res) => {
    const theme = require('./services/theme');
    const branchId = Number(req.query.branch) || (db.get().prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get() || {}).id;
    let settings = theme.DEFAULT_THEME;
    if (req.query.t) { // customer token → that session's branch
      try { const s = require('./services/sessions').resolveCustomerToken(String(req.query.t), { allowClosed: true }); settings = theme.activeTheme(s.branch_id).settings; } catch { /* default theme */ }
    } else if (branchId) settings = theme.activeTheme(branchId).settings;
    res.type('css').set('Cache-Control', 'no-cache').send(theme.css(settings, ['customer', 'pos', 'admin', 'kds'].includes(req.query.scope) ? req.query.scope : 'customer'));
  });

  // Media files
  app.get('/media/:id', (req, res, next) => {
    const a = db.get().prepare('SELECT * FROM media_assets WHERE id=?').get(Number(req.params.id));
    if (!a) return res.status(404).end();
    const file = path.join(config.uploadDir, a.filename);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=86400', 'Last-Modified': new Date(a.created_at).toUTCString() });
    if (a.mime === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    if (a.mime.startsWith('font/')) res.set('Access-Control-Allow-Origin', '*');
    fs.createReadStream(file).pipe(res);
  });

  // Front-ends
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'], setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); } }));
  app.get('/t/:token', (req, res) => res.sendFile(path.join(pub, 'order', 'index.html')));
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // Errors
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'ไม่พบ API' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (e instanceof AppError) return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
    if (e.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'ข้อมูลไม่ถูกต้อง' } });
    if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'file_too_large', message: 'ไฟล์ใหญ่เกินกำหนด' } });
    if (e.status && e.code) return res.status(e.status).json({ error: { code: e.code, message: e.message } });
    console.error('[error]', req.method, req.originalUrl, e);
    res.status(500).json({ error: { code: 'server_error', message: 'เกิดข้อผิดพลาดในระบบ' } });
  });
  return app;
}

function start(port = config.port) {
  const app = createApp();
  const server = http.createServer(app);
  realtime.init(server);
  require('./services/printing').start();
  require('./services/scheduler').start();
  return new Promise((resolve) => server.listen(port, config.host, () => resolve(server)));
}

function stop(server) {
  require('./services/printing').stop();
  require('./services/scheduler').stop();
  return new Promise((resolve) => { if (realtime.io) realtime.io.close(); server.close(() => resolve()); });
}

if (require.main === module) {
  start().then((server) => {
    const { port } = server.address();
    const hasStaff = db.get().prepare('SELECT 1 FROM staff LIMIT 1').get();
    console.log(`Buffet system running on http://localhost:${port}`);
    if (!hasStaff) console.log('No staff accounts yet — run "npm run setup" to create the restaurant and owner account.');
  });
}

module.exports = { createApp, start, stop };
