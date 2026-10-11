'use strict';
// Font registry for server-side rendering (print bitmaps & previews).
// Sources: bundled Sarabun (OFL), fonts uploaded in the media library, and Google Fonts downloaded on demand.
const fs = require('fs');
const path = require('path');
const { GlobalFonts } = require('@napi-rs/canvas');
const config = require('../config');
const db = require('../db');

const BUNDLED = 'Sarabun';
const registered = new Set();
const pending = new Map();

function registerBundled() {
  if (registered.has(BUNDLED)) return;
  const dir = path.join(__dirname, '..', 'assets', 'fonts');
  GlobalFonts.registerFromPath(path.join(dir, 'Sarabun-Regular.ttf'), BUNDLED);
  GlobalFonts.registerFromPath(path.join(dir, 'Sarabun-Bold.ttf'), BUNDLED);
  registered.add(BUNDLED);
}

const safeName = (f) => String(f || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60);

// Download TTF files of a Google font family (regular + bold) into data/fonts and register them.
async function fetchGoogleFont(family) {
  family = safeName(family);
  if (!family) throw new Error('invalid font family');
  const dir = path.join(config.fontCacheDir, family.replace(/ /g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const w of [400, 700]) {
    const f = path.join(dir, `${w}.ttf`);
    if (!fs.existsSync(f)) {
      const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${w}`, { headers: { 'user-agent': 'Mozilla/4.0' } });
      if (!css.ok) { if (w === 700) continue; throw new Error(`Google Fonts: ${family} not found (${css.status})`); }
      const urls = (await css.text()).match(/https:\/\/[^)]+\.ttf/g) || [];
      if (!urls.length) { if (w === 700) continue; throw new Error('Google Fonts: TTF not available'); }
      // The last @font-face block usually covers latin; Thai/CJK subsets come first. Download all subsets & merge by registering each.
      let i = 0;
      for (const u of urls) {
        const r = await fetch(u);
        if (!r.ok) continue;
        const sub = path.join(dir, `${w}-${i++}.ttf`);
        fs.writeFileSync(sub, Buffer.from(await r.arrayBuffer()));
        files.push(sub);
      }
      fs.writeFileSync(f, ''); // marker
    } else {
      for (const x of fs.readdirSync(dir)) if (x.startsWith(`${w}-`)) files.push(path.join(dir, x));
    }
  }
  for (const f of files) GlobalFonts.registerFromPath(f, family);
  registered.add(family);
  return family;
}

function registerUploaded(family) {
  const rows = db.get().prepare("SELECT * FROM media_assets WHERE kind='font' AND font_family=?").all(family);
  for (const r of rows) GlobalFonts.registerFromPath(path.join(config.uploadDir, r.filename), family);
  if (rows.length) registered.add(family);
  return rows.length > 0;
}

// Ensure a family is available; falls back to the bundled Thai font. Returns the family string for ctx.font.
async function ensureFont(family) {
  registerBundled();
  family = safeName(family);
  if (!family || family === BUNDLED) return BUNDLED;
  if (registered.has(family)) return `${family}, ${BUNDLED}`;
  if (registerUploaded(family)) return `${family}, ${BUNDLED}`;
  if (!pending.has(family)) pending.set(family, fetchGoogleFont(family).catch(() => null).finally(() => pending.delete(family)));
  const ok = await pending.get(family);
  return ok ? `${family}, ${BUNDLED}` : BUNDLED;
}

module.exports = { ensureFont, registerBundled, fetchGoogleFont, BUNDLED, safeName };
