'use strict';
// Creates an online backup of the SQLite database into data/backups (safe while the server is running).
const db = require('../server/db');
const scheduler = require('../server/services/scheduler');
db.open();
scheduler.backup('manual').then((f) => { console.log('✔ Backup:', f); db.close(); }).catch((e) => { console.error(e); process.exit(1); });
