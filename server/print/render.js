'use strict';
// Renders a list of layout blocks onto a 1-bit bitmap the width of the thermal paper.
// Text is drawn with real fonts (Thai shaping handled by Skia), so printers without Thai code pages still print correctly.
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { ensureFont } = require('./fonts');
const config = require('../config');

const DOTS = { 58: 384, 80: 576 };
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const { segment } of segmenter.segment(para)) {
      const test = line + segment;
      if (ctx.measureText(test).width <= maxW || !line) {
        if (ctx.measureText(test).width > maxW && !line) {
          // single very long segment → hard break by characters
          let chunk = '';
          for (const ch of [...segment]) { if (ctx.measureText(chunk + ch).width > maxW && chunk) { out.push(chunk); chunk = ''; } chunk += ch; }
          line = chunk;
        } else line = test;
      } else { out.push(line.trimEnd()); line = segment.trimStart(); }
    }
    out.push(line);
  }
  return out;
}

async function loadAsset(src) {
  try {
    if (!src) return null;
    if (Buffer.isBuffer(src)) return await loadImage(src);
    const m = /^\/media\/(\d+)$/.exec(src);
    if (m) {
      const row = require('../db').get().prepare('SELECT filename, mime FROM media_assets WHERE id=?').get(Number(m[1]));
      if (!row) return null;
      return await loadImage(fs.readFileSync(path.join(config.uploadDir, row.filename)));
    }
    return null;
  } catch { return null; }
}

/**
 * doc: {paper:58|80, font, baseSize, margin, blocks:[...]}
 * Block types: text{text,size,bold,align}, row{left,right,size,bold}, line{style}, space{h}, qr{data,size},
 *              image{src,maxW,maxH}, box{cols:[{label,value}], size}, invert{text,size}
 */
async function renderDoc(doc) {
  const width = doc.dots || DOTS[doc.paper] || 576;
  const family = await ensureFont(doc.font);
  const margin = doc.margin ?? 8;
  const inner = width - margin * 2;
  const base = doc.baseSize || (width <= 384 ? 20 : 24);
  const canvas = createCanvas(width, 8000);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, 8000);
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.textBaseline = 'alphabetic';
  let y = margin;
  const font = (size, bold) => { ctx.font = `${bold ? 'bold ' : ''}${size}px ${family}`; };
  const lh = (size) => Math.round(size * (doc.lineHeight || 1.35));

  for (const b of doc.blocks) {
    if (!b) continue;
    switch (b.t) {
      case 'text': case 'invert': {
        const size = b.size || base; font(size, b.bold || b.t === 'invert');
        const lines = wrap(ctx, b.text, inner - (b.t === 'invert' ? 16 : 0));
        if (b.t === 'invert') { ctx.fillRect(margin, y, inner, lines.length * lh(size) + 8); ctx.fillStyle = '#fff'; y += 4; }
        for (const ln of lines) {
          const w = ctx.measureText(ln).width;
          const x = b.align === 'center' || b.t === 'invert' ? (width - w) / 2 : b.align === 'right' ? width - margin - w : margin;
          ctx.fillText(ln, x, y + size);
          y += lh(size);
        }
        if (b.t === 'invert') { ctx.fillStyle = '#000'; y += 4; }
        break;
      }
      case 'row': {
        const size = b.size || base; font(size, b.bold);
        const right = String(b.right ?? '');
        const rw = ctx.measureText(right).width;
        const lines = wrap(ctx, b.left, inner - rw - 12);
        lines.forEach((ln, i) => {
          ctx.fillText(ln, margin + (b.indent || 0), y + size);
          if (i === 0) ctx.fillText(right, width - margin - rw, y + size);
          y += lh(size);
        });
        break;
      }
      case 'line': {
        y += 6;
        if (b.style === 'solid' || b.style === 'double') { ctx.fillRect(margin, y, inner, 2); if (b.style === 'double') ctx.fillRect(margin, y + 5, inner, 2); }
        else for (let x = margin; x < width - margin; x += 12) ctx.fillRect(x, y, 7, 2);
        y += b.style === 'double' ? 13 : 8;
        break;
      }
      case 'space': y += b.h || 10; break;
      case 'qr': {
        const size = Math.min(b.size || Math.round(width * 0.6), inner);
        const qc = createCanvas(size, size);
        await QRCode.toCanvas(qc, String(b.data), { width: size, margin: 1, errorCorrectionLevel: 'M' }).catch(async () => {
          const png = await QRCode.toBuffer(String(b.data), { width: size, margin: 1 });
          const img = await loadImage(png); qc.getContext('2d').drawImage(img, 0, 0, size, size);
        });
        ctx.drawImage(qc, Math.round((width - size) / 2), y);
        y += size + 6;
        break;
      }
      case 'image': {
        const img = await loadAsset(b.src);
        if (!img) break;
        const maxW = Math.min(b.maxW || inner, inner), maxH = b.maxH || 160;
        const r = Math.min(maxW / img.width, maxH / img.height, 1.5);
        const w = Math.round(img.width * r), h = Math.round(img.height * r);
        ctx.drawImage(img, Math.round((width - w) / 2), y, w, h);
        y += h + 6;
        break;
      }
      case 'box': {
        const size = b.size || base * 1.6;
        const top = y + 4; const cols = b.cols || [];
        const cw = inner / cols.length;
        const labelSize = Math.round(base * 0.9);
        const h = labelSize + size + 28;
        ctx.lineWidth = 2; ctx.strokeRect(margin + 1, top, inner - 2, h);
        cols.forEach((c, i) => {
          font(labelSize, false); let w = ctx.measureText(c.label).width;
          ctx.fillText(c.label, margin + cw * i + (cw - w) / 2, top + 8 + labelSize);
          font(size, true); w = ctx.measureText(c.value).width;
          ctx.fillText(c.value, margin + cw * i + (cw - w) / 2, top + 14 + labelSize + size);
        });
        y = top + h + 8;
        break;
      }
      default: break;
    }
  }
  y += margin + (doc.feed ?? 16);
  const out = createCanvas(width, y);
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}

// Threshold the canvas into 1-bit rows (MSB first) for ESC/POS raster
function toMono(canvas, threshold = 160) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const bytesPerRow = Math.ceil(width / 8);
  const bits = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const lum = data[i + 3] < 128 ? 255 : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < threshold) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return { width, height, bytesPerRow, bits };
}

module.exports = { renderDoc, toMono, DOTS, wrap };
