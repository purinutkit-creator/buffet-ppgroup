'use strict';
// SQLite database (better-sqlite3). All money values are stored as integer satang (1 THB = 100).
// All timestamps are stored as epoch milliseconds (server clock).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,              -- JSON {th,en,zh}
  logo_asset_id INTEGER,
  tax_id TEXT, phone TEXT,
  contact TEXT DEFAULT '{}',       -- JSON {line, facebook, instagram, email, website}
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,              -- JSON {th,en,zh}
  address TEXT DEFAULT '{}',       -- JSON {th,en,zh}
  phone TEXT, tax_id TEXT,
  open_hours TEXT DEFAULT '[]',    -- JSON [{day:0-6, open:"11:00", close:"22:00"}]
  holidays TEXT DEFAULT '[]',      -- JSON ["2026-12-31"]
  settings TEXT DEFAULT '{}',      -- JSON, see services/settings.js defaults
  banner_asset_id INTEGER, banner_mobile_asset_id INTEGER, logo_asset_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', -- normal | vip | outdoor
  sort INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 1000, height INTEGER NOT NULL DEFAULT 600
);
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  zone_id INTEGER REFERENCES zones(id),
  code TEXT NOT NULL,              -- e.g. "7", "T07", "V.22"
  shape TEXT NOT NULL DEFAULT 'square', -- square | rect | round
  seats INTEGER NOT NULL DEFAULT 4,
  x INTEGER NOT NULL DEFAULT 20, y INTEGER NOT NULL DEFAULT 20,
  w INTEGER NOT NULL DEFAULT 90, h INTEGER NOT NULL DEFAULT 90, rotation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available', -- available | occupied | cleaning | disabled | reserved (payment states derive from session)
  reserved_note TEXT,
  current_session_id INTEGER,
  UNIQUE(branch_id, code)
);
CREATE TABLE IF NOT EXISTS buffet_packages (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER REFERENCES branches(id),   -- NULL = all branches
  code TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT DEFAULT '{}',
  cover_asset_id INTEGER, color TEXT DEFAULT '#0b2a6f',
  duration_min INTEGER NOT NULL DEFAULT 120,
  order_cutoff_min INTEGER NOT NULL DEFAULT 0,  -- ordering closes N minutes before dining end
  service_start TEXT, service_end TEXT,         -- "11:00" / "22:00" when the package may be opened
  days TEXT DEFAULT '[0,1,2,3,4,5,6]',
  max_per_round INTEGER NOT NULL DEFAULT 0,     -- 0 = unlimited
  round_per_guest INTEGER NOT NULL DEFAULT 1,   -- max_per_round multiplied by guest count
  round_interval_min INTEGER NOT NULL DEFAULT 0,
  max_per_item_per_guest INTEGER NOT NULL DEFAULT 0, -- default "times orderable per item" (0 = unlimited)
  leftover_policy TEXT DEFAULT '{}',            -- JSON {text:{th,en,zh}, fee_per_unit, unit}
  overtime_fee TEXT DEFAULT '{}',               -- JSON {block_min, amount_per_guest} satang
  service_charge_enabled INTEGER NOT NULL DEFAULT 1,
  vat_enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS package_prices (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES buffet_packages(id) ON DELETE CASCADE,
  code TEXT NOT NULL,              -- adult | child | senior | toddler | custom
  label TEXT NOT NULL,             -- JSON {th,en,zh}
  rule_type TEXT NOT NULL DEFAULT 'age', -- age | height | none
  min_value REAL, max_value REAL,  -- inclusive range (years or cm); NULL = open
  price INTEGER NOT NULL,          -- satang per guest
  priority INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER REFERENCES branches(id),
  name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  code TEXT NOT NULL, name TEXT NOT NULL, color TEXT DEFAULT '#334155',
  printer_id INTEGER, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER REFERENCES branches(id),
  category_id INTEGER REFERENCES categories(id),
  code TEXT,
  name TEXT NOT NULL, description TEXT DEFAULT '{}', ingredients TEXT DEFAULT '{}',
  allergens TEXT DEFAULT '[]',
  image_asset_id INTEGER,
  extra_price INTEGER NOT NULL DEFAULT 0,     -- charged on top of the package (satang)
  cost INTEGER NOT NULL DEFAULT 0,            -- cost per unit for gross profit reports
  max_per_order INTEGER NOT NULL DEFAULT 0,
  max_per_guest INTEGER NOT NULL DEFAULT 0,
  max_per_table INTEGER NOT NULL DEFAULT 0,
  prep_minutes INTEGER NOT NULL DEFAULT 10,
  station_id INTEGER REFERENCES kitchen_stations(id),
  printer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'available',   -- available | out | stopped
  available_from TEXT, available_to TEXT,
  tags TEXT DEFAULT '[]',                      -- ["special","recommended"]
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_item_packages (
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES buffet_packages(id) ON DELETE CASCADE,
  extra_price INTEGER,                         -- NULL = use menu_items.extra_price
  PRIMARY KEY(menu_item_id, package_id)
);
CREATE TABLE IF NOT EXISTS menu_options (
  id INTEGER PRIMARY KEY,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'single',         -- single | multi
  required INTEGER NOT NULL DEFAULT 0,
  max_select INTEGER NOT NULL DEFAULT 0,
  choices TEXT NOT NULL DEFAULT '[]',          -- JSON [{id, name:{th,en,zh}, price}]
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS table_sessions (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  table_id INTEGER NOT NULL REFERENCES tables(id),
  public_code TEXT NOT NULL UNIQUE,            -- e.g. BF00128 (shown to customers)
  token_hash TEXT NOT NULL UNIQUE,             -- sha256 of the QR token
  token_enc TEXT NOT NULL,                     -- token encrypted at rest (for reprinting the QR)
  token_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',       -- active | billing | closed | merged | void
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, order_end_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  contact_name TEXT, member_id INTEGER REFERENCES members(id),
  guests_count INTEGER NOT NULL,
  manual_discount TEXT DEFAULT NULL,           -- JSON {type:amount|percent, value, reason, staff_id}
  adjustments TEXT DEFAULT '[]',               -- JSON [{code:'leftover'|'overtime'|'custom', label, amount}]
  merged_into INTEGER REFERENCES table_sessions(id),
  alerts_sent TEXT DEFAULT '[]',
  opened_by INTEGER, opened_at INTEGER NOT NULL,
  closed_by INTEGER, closed_at INTEGER,
  last_order_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_branch_status ON table_sessions(branch_id, status);
CREATE TABLE IF NOT EXISTS session_guests (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES table_sessions(id),
  label TEXT NOT NULL,                         -- "A", "B" ... (shown as คุณ A)
  display_name TEXT,
  package_id INTEGER NOT NULL REFERENCES buffet_packages(id),
  price_id INTEGER REFERENCES package_prices(id),
  price_code TEXT, unit_price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL REFERENCES table_sessions(id),
  order_no TEXT NOT NULL,
  guest_label TEXT, device_id TEXT,
  idempotency_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'customer',     -- customer | staff
  staff_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  session_id INTEGER NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,                          -- JSON snapshot
  qty INTEGER NOT NULL,
  options TEXT DEFAULT '[]',                   -- JSON [{option, choice, price}]
  note TEXT,
  unit_extra INTEGER NOT NULL DEFAULT 0,       -- satang per unit charged on bill
  unit_cost INTEGER NOT NULL DEFAULT 0,
  guest_label TEXT,
  station_id INTEGER,
  ticket_id INTEGER,
  status TEXT NOT NULL DEFAULT 'received',     -- received | sent | preparing | cooking | ready | served | cancelled | unavailable
  status_at INTEGER NOT NULL,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  ready_at INTEGER, served_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_session ON order_items(session_id);
CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL, order_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
  station_id INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_branch ON kitchen_tickets(branch_id, status);
CREATE TABLE IF NOT EXISTS staff_call_types (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER REFERENCES branches(id),
  name TEXT NOT NULL, icon TEXT DEFAULT '🔔', color TEXT DEFAULT '#0b2a6f',
  image_asset_id INTEGER, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  is_bill INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS staff_calls (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL, session_id INTEGER NOT NULL, table_id INTEGER NOT NULL,
  type_id INTEGER, label TEXT NOT NULL, note TEXT, guest_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | accepted | in_progress | done | cancelled
  created_at INTEGER NOT NULL,
  accepted_at INTEGER, accepted_by INTEGER,
  done_at INTEGER, done_by INTEGER
);
CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  code TEXT NOT NULL, name TEXT NOT NULL, color TEXT DEFAULT '#b08d57',
  min_spent INTEGER NOT NULL DEFAULT 0,        -- satang, lifetime spend to reach the tier
  min_points INTEGER NOT NULL DEFAULT 0,
  baht_per_point INTEGER NOT NULL DEFAULT 50,  -- e.g. 50 THB = 1 point
  multiplier REAL NOT NULL DEFAULT 1,
  image_asset_id INTEGER, benefits TEXT DEFAULT '{}', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  first_name TEXT, last_name TEXT, birthday TEXT, email TEXT,
  extra TEXT DEFAULT '{}',
  tier_id INTEGER REFERENCES tiers(id),
  points INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER, verified_at INTEGER,
  birthday_bonus_year INTEGER,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS point_transactions (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  type TEXT NOT NULL,                          -- earn | redeem | redeem_refund | adjust | expire | bonus_signup | bonus_birthday | reverse
  points INTEGER NOT NULL,                     -- +/- delta
  remaining INTEGER NOT NULL DEFAULT 0,        -- for positive lots: points still available (FIFO consumption)
  expires_at INTEGER,
  ref_type TEXT, ref_id INTEGER,
  reason TEXT, staff_id INTEGER, approver_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pt_member ON point_transactions(member_id);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, description TEXT DEFAULT '{}', image_asset_id INTEGER,
  type TEXT NOT NULL,                          -- discount_amount | discount_percent | free_item | package_upgrade
  value INTEGER NOT NULL DEFAULT 0,            -- satang or percent*100
  menu_item_id INTEGER, from_package_id INTEGER, to_package_id INTEGER,
  points_cost INTEGER NOT NULL DEFAULT 0,
  members_only INTEGER NOT NULL DEFAULT 1,
  tier_ids TEXT DEFAULT '[]', branch_ids TEXT DEFAULT '[]',
  days TEXT DEFAULT '[]', time_from TEXT, time_to TEXT,
  starts_at INTEGER, ends_at INTEGER,
  total_quota INTEGER NOT NULL DEFAULT 0, per_member_quota INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  min_spend INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  stackable INTEGER NOT NULL DEFAULT 0,
  code_valid_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id),
  member_id INTEGER REFERENCES members(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued',       -- issued | applied | used | cancelled | expired
  points_spent INTEGER NOT NULL DEFAULT 0,
  session_id INTEGER, bill_id INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL, used_at INTEGER, cancelled_at INTEGER
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, phone TEXT,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  pin_hash TEXT NOT NULL,
  branch_ids TEXT NOT NULL DEFAULT '[]',       -- [] = all branches
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  created_at INTEGER NOT NULL, last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS staff_tokens (
  token_hash TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  branch_id INTEGER NOT NULL,
  device TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER REFERENCES branches(id),
  code TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL,                          -- cash | promptpay | transfer | card | other
  config TEXT DEFAULT '{}',                    -- {promptpay_id}
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
  bill_no TEXT NOT NULL UNIQUE,
  split_label TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open | paid | void | refunded | partially_refunded
  lines TEXT NOT NULL DEFAULT '[]',
  package_total INTEGER NOT NULL DEFAULT 0, extras_total INTEGER NOT NULL DEFAULT 0,
  adjustments_total INTEGER NOT NULL DEFAULT 0, discount_total INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL DEFAULT 0, service_charge INTEGER NOT NULL DEFAULT 0,
  before_vat INTEGER NOT NULL DEFAULT 0, vat INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  paid_total INTEGER NOT NULL DEFAULT 0, refunded_total INTEGER NOT NULL DEFAULT 0,
  member_id INTEGER, points_earned INTEGER NOT NULL DEFAULT 0,
  tax_invoice TEXT,                             -- JSON {no, name, tax_id, address, branch}
  staff_id INTEGER, created_at INTEGER NOT NULL, paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL, session_id INTEGER NOT NULL, bill_id INTEGER NOT NULL REFERENCES bills(id),
  method_id INTEGER, method_type TEXT NOT NULL, method_name TEXT NOT NULL,
  amount INTEGER NOT NULL, received INTEGER, change_amount INTEGER NOT NULL DEFAULT 0,
  reference TEXT, refunded INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  staff_id INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL, bill_id INTEGER NOT NULL, payment_id INTEGER,
  amount INTEGER NOT NULL, reason TEXT NOT NULL,
  points_reversed INTEGER NOT NULL DEFAULT 0,
  staff_id INTEGER, approver_id INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS printers (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  connection TEXT NOT NULL DEFAULT 'network',  -- network | bridge | browser
  address TEXT,                                -- host:port for network, target for bridge
  paper_width INTEGER NOT NULL DEFAULT 80,     -- 58 | 80
  dots INTEGER,                                -- printable dots (384 for 58mm, 576 for 80mm)
  config TEXT DEFAULT '{}',                    -- {cut:true, beep:false, drawer:false, margin:8}
  bridge_key_hash TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',      -- unknown | online | offline | error
  last_seen_at INTEGER, last_error TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS print_routes (
  branch_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,                      -- qr_ticket | member_signup | kitchen | receipt | close_summary | tax_invoice
  printer_id INTEGER,
  copies INTEGER NOT NULL DEFAULT 1,
  auto INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(branch_id, doc_type)
);
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL, printer_id INTEGER,
  doc_type TEXT NOT NULL, ref_id INTEGER,
  payload TEXT NOT NULL,                       -- JSON document (rendered on demand)
  copies INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | printing | printed | failed
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  claimed_by TEXT, claimed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, printed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(printer_id, status);
CREATE TABLE IF NOT EXISTS themes (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                          -- banner | banner_mobile | logo | food | package | promotion | call_icon | tier | receipt_logo | font | other
  filename TEXT NOT NULL, original_name TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL,
  width INTEGER, height INTEGER, font_family TEXT,
  uploaded_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER, staff_id INTEGER, approver_id INTEGER,
  action TEXT NOT NULL, entity TEXT, entity_id INTEGER,
  data TEXT, ip TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS sequences (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

let db;
function open(file = config.dbFile) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
function get() { if (!db) open(); return db; }
function close() { if (db) { db.close(); db = null; } }

// Small helpers
const J = (v, d = null) => { if (v == null || v === '') return d; try { return JSON.parse(v); } catch { return d; } };
const S = (v) => JSON.stringify(v ?? null);

function nextSeq(key) {
  const d = get();
  d.prepare('INSERT INTO sequences(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').run(key);
  return d.prepare('SELECT value FROM sequences WHERE key=?').get(key).value;
}

module.exports = { open, get, close, J, S, nextSeq };
