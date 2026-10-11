'use strict';
// Background jobs: dining-time alerts, points expiry, automatic backups.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { now } = require('../lib/util');
const { branchSettings } = require('./settings');
const rt = require('../realtime');

function checkTimeAlerts() {
  const d = db.get();
  const rows = d.prepare("SELECT s.*, t.code table_code FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.status IN ('active','billing')").all();
  const t = now();
  for (const s of rows) {
    const settings = branchSettings(s.branch_id);
    const sent = db.J(s.alerts_sent, []);
    const left = s.end_at - t;
    const marks = [...settings.time_alerts_min].sort((a, b) => b - a);
    let changed = false;
    for (const m of marks) {
      const key = `end-${m}`;
      if (left <= m * 60000 && left > 0 && !sent.includes(key)) {
        // Only the tightest crossed threshold is announced (avoid 3 alerts at once after a restart)
        const tighter = marks.filter((x) => x < m && left <= x * 60000);
        for (const x of [m, ...tighter]) if (!sent.includes(`end-${x}`)) sent.push(`end-${x}`);
        const min = tighter.length ? Math.min(...tighter) : m;
        rt.toSession(s.id, 'session:alert', { kind: 'time_left', minutes: min, end_at: s.end_at });
        rt.toStaff(s.branch_id, 'session:alert', { kind: 'time_left', minutes: min, table_code: s.table_code, session_id: s.id });
        changed = true;
      }
    }
    if (s.order_end_at < s.end_at && t >= s.order_end_at && !sent.includes('order_end')) {
      sent.push('order_end'); changed = true;
      rt.toSession(s.id, 'session:alert', { kind: 'ordering_closed' });
    }
    if (left <= 0 && !sent.includes('time_up')) {
      sent.push('time_up'); changed = true;
      rt.toSession(s.id, 'session:alert', { kind: 'time_up' });
      rt.toStaff(s.branch_id, 'session:alert', { kind: 'time_up', table_code: s.table_code, session_id: s.id });
      rt.toStaff(s.branch_id, 'tables:changed', { table_id: s.table_id });
    }
    if (changed) d.prepare('UPDATE table_sessions SET alerts_sent=? WHERE id=?').run(JSON.stringify(sent), s.id);
  }
}

async function backup(label = 'auto') {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.backupDir, `buffet-${label}-${stamp}.db`);
  await db.get().backup(file);
  const files = fs.readdirSync(config.backupDir).filter((f) => f.startsWith(`buffet-${label}-`)).sort();
  while (files.length > config.backupKeep) fs.unlinkSync(path.join(config.backupDir, files.shift()));
  return file;
}

const timers = [];
function start() {
  timers.push(setInterval(() => { try { checkTimeAlerts(); } catch (e) { console.error('[alerts]', e); } }, 15000));
  timers.push(setInterval(() => { try { require('./members').expirePoints(); } catch (e) { console.error('[points]', e); } }, 3600e3));
  if (config.autoBackupHours > 0 && !config.isTest) timers.push(setInterval(() => backup().catch((e) => console.error('[backup]', e)), config.autoBackupHours * 3600e3));
}
function stop() { timers.splice(0).forEach(clearInterval); }

module.exports = { start, stop, checkTimeAlerts, backup };
