'use strict';
// Runtime configuration from environment variables. See README.md → "การตั้งค่า (Environment)".
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(dataDir, { recursive: true });

// APP_SECRET encrypts QR tokens at rest. If not provided, one is generated once and stored in data/.secret
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const f = path.join(dataDir, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'buffet.db'),
  uploadDir: path.join(dataDir, 'uploads'),
  fontCacheDir: path.join(dataDir, 'fonts'),
  backupDir: path.join(dataDir, 'backups'),
  // Base URL customers reach (used inside printed QR codes), e.g. https://order.myrestaurant.com
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  secret: loadSecret(),
  staffTokenHours: Number(process.env.STAFF_TOKEN_HOURS || 14),
  // OTP delivery for member sign-up: "webhook" (POST to SMS_WEBHOOK_URL) or "dev" (code returned in API response — testing only)
  otpMode: process.env.OTP_MODE || 'dev',
  smsWebhookUrl: process.env.SMS_WEBHOOK_URL || '',
  smsWebhookToken: process.env.SMS_WEBHOOK_TOKEN || '',
  backupKeep: Number(process.env.BACKUP_KEEP || 14),
  autoBackupHours: Number(process.env.AUTO_BACKUP_HOURS || 24),
  googleFontsApiKey: process.env.GOOGLE_FONTS_API_KEY || '',
  isTest: process.env.NODE_ENV === 'test',
};
