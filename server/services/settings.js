'use strict';
// Branch settings with defaults. Stored as JSON in branches.settings and merged with these defaults.
const db = require('../db');

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Bangkok',
  currency: 'THB',
  vat_rate: 7,                 // percent
  service_rate: 10,            // percent
  prices_include_vat: false,   // false: VAT added on top (as on the sample receipt)
  service_charge_on_extras: true,
  after_payment_table_status: 'cleaning', // cleaning | available
  time_alerts_min: [30, 15, 5],
  lock_orders_after_time_up: true,
  kds_thresholds: { warn: 6, danger: 11 }, // minutes: >=warn yellow, >=danger red
  kds_sound: true,
  call_cooldown_sec: 60,
  allow_mixed_packages: true,
  member_signup_slip: true,    // auto print member sign-up QR when the table is opened for a non-member
  require_manager_approval: ['refund', 'void_bill', 'adjust_points', 'discount_over', 'cancel_served_item', 'reopen_session'],
  discount_approval_over_percent: 20,
  max_upload_mb: 5,
  terms: { th: '', en: '', zh: '' },     // sanitized HTML from the rich text editor
  qr_ticket_footer: { th: 'ขอบคุณที่ใช้บริการ', en: 'Thank you', zh: '谢谢光临' },
  receipt_footer: { th: 'กรณีที่ลูกค้าสั่งอาหารและทานไม่หมด ทางร้านขออนุญาตปรับตามราคา A la Carte', en: '', zh: '' },
  member_signup_text: { th: 'สมัครสมาชิกวันนี้ รับคะแนนสะสมทุกการใช้บริการ', en: 'Join our membership and earn points every visit', zh: '立即注册会员，每次消费累积积分' },
  points: { expiry_days: 365, signup_bonus: 50, birthday_bonus: 100 },
  languages: ['th', 'en', 'zh'],
  default_language: 'th',
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = (k in base) ? merge(base[k], over[k]) : over[k];
  return out;
}

function branchSettings(branchId) {
  const row = db.get().prepare('SELECT settings FROM branches WHERE id=?').get(branchId);
  return merge(DEFAULT_SETTINGS, db.J(row && row.settings, {}));
}

module.exports = { DEFAULT_SETTINGS, branchSettings, merge };
