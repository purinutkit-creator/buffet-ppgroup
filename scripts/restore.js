'use strict';
// Usage: npm run restore -- data/backups/buffet-manual-XXXX.db
// Stop the server first. The current database is kept as buffet.db.before-restore-<time>.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../server/config');
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('ระบุไฟล์ backup ที่มีอยู่จริง'); process.exit(1); }
const check = new Database(src, { readonly: true });
const ok = check.pragma('integrity_check', { simple: true });
const hasTables = check.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('restaurants','table_sessions','bills')").get().c === 3;
check.close();
if (ok !== 'ok' || !hasTables) { console.error('ไฟล์ backup ไม่สมบูรณ์หรือไม่ใช่ฐานข้อมูลของระบบนี้'); process.exit(1); }
const target = config.dbFile;
if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore-${Date.now()}`);
for (const ext of ['-wal', '-shm']) if (fs.existsSync(target + ext)) fs.unlinkSync(target + ext);
fs.copyFileSync(path.resolve(src), target);
console.log('✔ กู้คืนข้อมูลเรียบร้อย:', target);
