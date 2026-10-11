'use strict';
// Theme & Design Studio: per-branch themes with fonts (Google / uploaded), sizes, colors, radius, spacing and print template.
const db = require('../db');
const { err, now } = require('../lib/util');
const { merge } = require('./settings');

const SCOPES = ['customer', 'pos', 'admin', 'kds'];
const fontScope = (family = 'Sarabun', extra = {}) => ({
  font_family: family, font_by_lang: { th: '', en: '', zh: '' },
  sizes: { store_name: 32, menu_name: 18, description: 14, body: 15, price: 16, category: 16, button: 16, heading: 22 },
  weights: { heading: 700, body: 400 }, letter_spacing: 0, line_height: 1.5, ...extra,
});

const DEFAULT_THEME = {
  scopes: {
    customer: fontScope('Sarabun'),
    pos: fontScope('Sarabun', { sizes: { store_name: 24, menu_name: 16, description: 13, body: 15, price: 16, category: 15, button: 16, heading: 20 } }),
    admin: fontScope('Sarabun', { sizes: { store_name: 22, menu_name: 15, description: 13, body: 14, price: 15, category: 14, button: 14, heading: 20 } }),
    kds: fontScope('Sarabun', { sizes: { store_name: 22, menu_name: 22, description: 15, body: 17, price: 16, category: 16, button: 18, heading: 28 } }),
  },
  colors: {
    bg: '#ffffff', surface: '#f2f3f5', text: '#1f2328', muted: '#6b7280', primary: '#0b2a6f', primary_text: '#ffffff',
    accent: '#c9a45c', category_text: '#9aa0a6', category_active: '#1f2328', nav_bg: '#ffffff', nav_text: '#1f2328',
    badge: '#2f80ed', success: '#16a34a', warning: '#f59e0b', danger: '#dc2626', alert: '#ef4444',
    status: { received: '#64748b', sent: '#0ea5e9', preparing: '#6366f1', cooking: '#f59e0b', ready: '#16a34a', served: '#0f766e', cancelled: '#9ca3af', unavailable: '#dc2626' },
  },
  radius: { image: 18, card: 16, button: 14, chip: 999 },
  shadow: 'soft', spacing: 16, button_height: 48, grid_gap: 16,
  print: {},
};

function normalize(settings) { return merge(DEFAULT_THEME, settings || {}); }

function activeTheme(branchId) {
  const t = db.get().prepare('SELECT * FROM themes WHERE branch_id=? AND is_active=1').get(branchId);
  return t ? { id: t.id, name: t.name, settings: normalize(db.J(t.settings, {})), updated_at: t.updated_at } : { id: null, name: 'Default', settings: normalize({}) };
}

const hex = /^#[0-9a-fA-F]{3,8}$/;
const fam = /^[A-Za-z0-9 _-]{0,60}$/;
// Validate user-provided settings (prevents CSS injection through values)
function validate(s) {
  const out = normalize(s);
  const walkColors = (o, p = 'colors') => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'object') walkColors(v, `${p}.${k}`); else if (!hex.test(v)) throw err(400, 'invalid_color', `สีไม่ถูกต้อง: ${p}.${k}`); } };
  walkColors(out.colors);
  for (const sc of SCOPES) {
    const x = out.scopes[sc];
    if (!fam.test(x.font_family)) throw err(400, 'invalid_font', 'ชื่อฟอนต์ไม่ถูกต้อง');
    for (const l of ['th', 'en', 'zh']) if (!fam.test(x.font_by_lang[l] || '')) throw err(400, 'invalid_font', 'ชื่อฟอนต์ไม่ถูกต้อง');
    for (const [k, v] of Object.entries(x.sizes)) if (!(Number(v) >= 8 && Number(v) <= 96)) throw err(400, 'invalid_size', `ขนาดตัวอักษร ${k} ต้องอยู่ระหว่าง 8-96px`);
    for (const [k, v] of Object.entries(x.weights)) if (![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(Number(v))) throw err(400, 'invalid_weight', `น้ำหนักฟอนต์ ${k} ไม่ถูกต้อง`);
    if (!(Number(x.letter_spacing) >= -5 && Number(x.letter_spacing) <= 20)) throw err(400, 'invalid_spacing', 'ระยะห่างตัวอักษรไม่ถูกต้อง');
    if (!(Number(x.line_height) >= 0.8 && Number(x.line_height) <= 3)) throw err(400, 'invalid_line_height', 'ความสูงบรรทัดไม่ถูกต้อง');
  }
  for (const [k, v] of Object.entries(out.radius)) if (!(Number(v) >= 0 && Number(v) <= 999)) throw err(400, 'invalid_radius', `ความโค้ง ${k} ไม่ถูกต้อง`);
  if (!['none', 'soft', 'medium', 'strong'].includes(out.shadow)) out.shadow = 'soft';
  for (const k of ['spacing', 'button_height', 'grid_gap']) if (!(Number(out[k]) >= 0 && Number(out[k]) <= 120)) throw err(400, 'invalid_value', `${k} ไม่ถูกต้อง`);
  if (out.print.font && !fam.test(out.print.font)) throw err(400, 'invalid_font', 'ชื่อฟอนต์ใบพิมพ์ไม่ถูกต้อง');
  return out;
}

const SHADOWS = { none: 'none', soft: '0 2px 10px rgba(0,0,0,.06)', medium: '0 6px 20px rgba(0,0,0,.10)', strong: '0 10px 30px rgba(0,0,0,.18)' };

// CSS variables + font loading for a scope
function css(settings, scope = 'customer') {
  const s = normalize(settings);
  const sc = s.scopes[scope] || s.scopes.customer;
  const families = new Set([sc.font_family, ...Object.values(sc.font_by_lang)].filter(Boolean));
  const uploaded = db.get().prepare("SELECT id, font_family, mime, filename FROM media_assets WHERE kind='font'").all();
  const upFamilies = new Set(uploaded.map((u) => u.font_family));
  let out = '';
  const google = [...families].filter((f) => !upFamilies.has(f) && !['system-ui', 'sans-serif', 'serif'].includes(f));
  if (google.length) out += `@import url('https://fonts.googleapis.com/css2?${google.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@300;400;500;600;700;800`).join('&')}&display=swap');\n`;
  for (const u of uploaded) if (families.has(u.font_family)) {
    const fmt = { 'font/ttf': 'truetype', 'font/otf': 'opentype', 'font/woff': 'woff', 'font/woff2': 'woff2' }[u.mime] || 'truetype';
    out += `@font-face{font-family:'${u.font_family}';src:url('/media/${u.id}') format('${fmt}');font-display:swap;}\n`;
  }
  const stack = (f) => `'${f}', 'Sarabun', 'Noto Sans Thai', 'Noto Sans SC', system-ui, sans-serif`;
  const v = {
    '--font': stack(sc.font_family),
    '--font-th': stack(sc.font_by_lang.th || sc.font_family), '--font-en': stack(sc.font_by_lang.en || sc.font_family), '--font-zh': stack(sc.font_by_lang.zh || sc.font_family),
    '--fs-store': `${sc.sizes.store_name}px`, '--fs-menu': `${sc.sizes.menu_name}px`, '--fs-desc': `${sc.sizes.description}px`, '--fs-body': `${sc.sizes.body}px`,
    '--fs-price': `${sc.sizes.price}px`, '--fs-cat': `${sc.sizes.category}px`, '--fs-btn': `${sc.sizes.button}px`, '--fs-h': `${sc.sizes.heading}px`,
    '--fw-h': sc.weights.heading, '--fw-body': sc.weights.body, '--ls': `${sc.letter_spacing}px`, '--lh': sc.line_height,
    '--bg': s.colors.bg, '--surface': s.colors.surface, '--text': s.colors.text, '--muted': s.colors.muted, '--primary': s.colors.primary, '--primary-text': s.colors.primary_text,
    '--accent': s.colors.accent, '--cat': s.colors.category_text, '--cat-active': s.colors.category_active, '--nav-bg': s.colors.nav_bg, '--nav-text': s.colors.nav_text,
    '--badge': s.colors.badge, '--success': s.colors.success, '--warning': s.colors.warning, '--danger': s.colors.danger, '--alert': s.colors.alert,
    '--r-img': `${s.radius.image}px`, '--r-card': `${s.radius.card}px`, '--r-btn': `${s.radius.button}px`, '--r-chip': `${s.radius.chip}px`,
    '--shadow': SHADOWS[s.shadow], '--sp': `${s.spacing}px`, '--btn-h': `${s.button_height}px`, '--gap': `${s.grid_gap}px`,
  };
  for (const [k, c] of Object.entries(s.colors.status)) v[`--st-${k}`] = c;
  out += `:root{${Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';')}}\n`;
  out += `html[lang=th] body{font-family:var(--font-th)} html[lang=en] body{font-family:var(--font-en)} html[lang=zh] body{font-family:var(--font-zh)}\n`;
  return out;
}

function saveTheme(branchId, { id, name, settings, activate }) {
  const d = db.get();
  const v = validate(settings);
  return d.transaction(() => {
    let tid = id;
    if (tid) {
      const r = d.prepare('UPDATE themes SET name=?, settings=?, updated_at=? WHERE id=? AND branch_id=?').run(String(name || 'Theme').slice(0, 60), JSON.stringify(v), now(), tid, branchId);
      if (!r.changes) throw err(404, 'theme_not_found', 'ไม่พบธีม');
    } else tid = d.prepare('INSERT INTO themes(branch_id, name, settings, is_active, updated_at) VALUES(?,?,?,0,?)').run(branchId, String(name || 'Theme').slice(0, 60), JSON.stringify(v), now()).lastInsertRowid;
    if (activate) { d.prepare('UPDATE themes SET is_active=0 WHERE branch_id=?').run(branchId); d.prepare('UPDATE themes SET is_active=1 WHERE id=?').run(tid); }
    return tid;
  })();
}

module.exports = { DEFAULT_THEME, SCOPES, normalize, validate, activeTheme, css, saveTheme };
