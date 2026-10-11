'use strict';
// Media library: validated uploads (JPG/PNG/WebP/SVG images and TTF/OTF/WOFF/WOFF2 fonts).
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { err, now, randomToken } = require('../lib/util');
const { loadImage } = require('@napi-rs/canvas');

const RECOMMENDED = {
  banner: { label: 'แบนเนอร์ร้าน', w: 1920, h: 800 },
  banner_mobile: { label: 'แบนเนอร์มือถือ', w: 1080, h: 600 },
  logo: { label: 'โลโก้ร้าน', w: 512, h: 512 },
  food: { label: 'รูปอาหาร', w: 800, h: 800 },
  package: { label: 'รูปแพ็กเกจ', w: 1200, h: 675 },
  promotion: { label: 'รูปโปรโมชั่น', w: 1200, h: 628 },
  call_icon: { label: 'ไอคอนเรียกพนักงาน', w: 256, h: 256 },
  tier: { label: 'รูปสมาชิก Tier', w: 512, h: 512 },
  receipt_logo: { label: 'โลโก้บนใบเสร็จ', w: 400, h: 200 },
  font: { label: 'ไฟล์ฟอนต์' },
  other: { label: 'อื่น ๆ' },
};

function sniff(buf) {
  const h = buf.subarray(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (h.subarray(0, 4).toString() === 'RIFF' && h.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  const sig = h.subarray(0, 4);
  if (sig.equals(Buffer.from([0, 1, 0, 0])) || sig.toString() === 'true') return { mime: 'font/ttf', ext: 'ttf', font: true };
  if (sig.toString() === 'OTTO') return { mime: 'font/otf', ext: 'otf', font: true };
  if (sig.toString() === 'wOFF') return { mime: 'font/woff', ext: 'woff', font: true };
  if (sig.toString() === 'wOF2') return { mime: 'font/woff2', ext: 'woff2', font: true };
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return { mime: 'image/svg+xml', ext: 'svg' };
  return null;
}

// Reject SVGs carrying active content instead of trying to clean them.
function checkSvg(text) {
  const bad = [/<script/i, /\son\w+\s*=/i, /javascript:/i, /<foreignObject/i, /<!ENTITY/i, /<!DOCTYPE/i, /<iframe/i, /<embed/i, /<object/i, /(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|webp);)/i, /@import/i, /url\(\s*['"]?\s*(?!#)/i];
  for (const r of bad) if (r.test(text)) throw err(400, 'unsafe_svg', 'ไฟล์ SVG มีเนื้อหาที่ไม่ปลอดภัย (script/ลิงก์ภายนอก/event handler)');
  const m = /<svg[^>]*>/i.exec(text)[0];
  const num = (a) => { const x = new RegExp(`\\s${a}\\s*=\\s*["']?([\\d.]+)`, 'i').exec(m); return x ? Math.round(Number(x[1])) : null; };
  let w = num('width'), h = num('height');
  const vb = /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(m);
  if ((!w || !h) && vb) { w = Math.round(+vb[1]); h = Math.round(+vb[2]); }
  return { width: w, height: h };
}

async function save({ buffer, originalname }, { kind = 'other', restaurantId, staffId, maxMb = 5, fontFamily }) {
  if (!RECOMMENDED[kind]) throw err(400, 'invalid_kind', 'ประเภทไฟล์ไม่ถูกต้อง');
  if (!buffer || !buffer.length) throw err(400, 'empty_file', 'ไม่พบไฟล์');
  if (buffer.length > maxMb * 1024 * 1024) throw err(413, 'file_too_large', `ไฟล์ใหญ่เกิน ${maxMb} MB`);
  const t = sniff(buffer);
  if (!t) throw err(415, 'unsupported_type', 'รองรับเฉพาะ JPG, PNG, WebP, SVG และฟอนต์ TTF/OTF/WOFF/WOFF2');
  if (kind === 'font' && !t.font) throw err(415, 'not_a_font', 'กรุณาเลือกไฟล์ฟอนต์');
  if (kind !== 'font' && t.font) throw err(415, 'not_an_image', 'กรุณาเลือกไฟล์รูปภาพ');
  let width = null, height = null, family = null;
  if (t.mime === 'image/svg+xml') ({ width, height } = checkSvg(buffer.toString('utf8')));
  else if (!t.font) {
    try { const img = await loadImage(buffer); width = img.width; height = img.height; } catch { throw err(400, 'corrupt_image', 'ไฟล์รูปภาพเสียหาย'); }
    if (width > 8000 || height > 8000) throw err(400, 'image_too_big', 'ขนาดรูปใหญ่เกินไป (สูงสุด 8000px)');
  } else {
    family = String(fontFamily || path.parse(originalname || 'Custom Font').name).replace(/[^A-Za-z0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Custom Font';
  }
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const filename = `${Date.now()}-${randomToken(8)}.${t.ext}`;
  fs.writeFileSync(path.join(config.uploadDir, filename), buffer);
  const r = db.get().prepare('INSERT INTO media_assets(restaurant_id, kind, filename, original_name, mime, size, width, height, font_family, uploaded_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(restaurantId, kind, filename, String(originalname || '').slice(0, 120), t.mime, buffer.length, width, height, family, staffId, now());
  return assetOut(db.get().prepare('SELECT * FROM media_assets WHERE id=?').get(r.lastInsertRowid));
}

function assetOut(a) {
  const rec = RECOMMENDED[a.kind] || {};
  const warn = rec.w && a.width && (a.width < rec.w * 0.5 || Math.abs(a.width / a.height - rec.w / rec.h) > 0.25) ? `ขนาดแนะนำ ${rec.w}×${rec.h}px` : null;
  return { id: a.id, url: `/media/${a.id}`, kind: a.kind, original_name: a.original_name, mime: a.mime, size: a.size, width: a.width, height: a.height, font_family: a.font_family, created_at: a.created_at, warning: warn };
}

function remove(id) {
  const d = db.get();
  const a = d.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
  if (!a) throw err(404, 'not_found', 'ไม่พบไฟล์');
  d.prepare('DELETE FROM media_assets WHERE id=?').run(id);
  // unlink references
  for (const [tbl, col] of [['restaurants', 'logo_asset_id'], ['branches', 'logo_asset_id'], ['branches', 'banner_asset_id'], ['branches', 'banner_mobile_asset_id'], ['menu_items', 'image_asset_id'], ['buffet_packages', 'cover_asset_id'], ['promotions', 'image_asset_id'], ['staff_call_types', 'image_asset_id'], ['tiers', 'image_asset_id']])
    d.prepare(`UPDATE ${tbl} SET ${col}=NULL WHERE ${col}=?`).run(id);
  try { fs.unlinkSync(path.join(config.uploadDir, a.filename)); } catch { /* already gone */ }
}

// Replace file content of an existing asset (keeps id so all references update)
async function replace(id, file, opts) {
  const d = db.get();
  const old = d.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
  if (!old) throw err(404, 'not_found', 'ไม่พบไฟล์');
  const n = await save(file, { ...opts, kind: old.kind, fontFamily: old.font_family });
  const nr = d.prepare('SELECT * FROM media_assets WHERE id=?').get(n.id);
  d.prepare('UPDATE media_assets SET filename=?, original_name=?, mime=?, size=?, width=?, height=?, created_at=? WHERE id=?').run(nr.filename, nr.original_name, nr.mime, nr.size, nr.width, nr.height, now(), id);
  d.prepare('DELETE FROM media_assets WHERE id=?').run(n.id);
  try { fs.unlinkSync(path.join(config.uploadDir, old.filename)); } catch { /* ignore */ }
  return assetOut(d.prepare('SELECT * FROM media_assets WHERE id=?').get(id));
}

module.exports = { RECOMMENDED, sniff, checkSvg, save, assetOut, remove, replace };
