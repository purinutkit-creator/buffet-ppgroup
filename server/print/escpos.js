'use strict';
// ESC/POS command builder: raster image printing (GS v 0), cut, beep and cash drawer.
const ESC = 0x1b, GS = 0x1d;

function build(mono, { cut = true, beep = false, drawer = false, copies = 1 } = {}) {
  const parts = [];
  for (let c = 0; c < copies; c++) {
    parts.push(Buffer.from([ESC, 0x40])); // init
    parts.push(Buffer.from([ESC, 0x61, 0x00])); // left align
    // Send the image in bands of 128 rows; many printers have small input buffers
    const band = 128;
    for (let y = 0; y < mono.height; y += band) {
      const h = Math.min(band, mono.height - y);
      const xL = mono.bytesPerRow & 0xff, xH = (mono.bytesPerRow >> 8) & 0xff;
      parts.push(Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, h & 0xff, (h >> 8) & 0xff]));
      parts.push(mono.bits.subarray(y * mono.bytesPerRow, (y + h) * mono.bytesPerRow));
    }
    parts.push(Buffer.from([ESC, 0x64, 0x03])); // feed 3 lines
    if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // partial cut with feed
  }
  if (beep) parts.push(Buffer.from([ESC, 0x42, 0x02, 0x02]));
  if (drawer) parts.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
  return Buffer.concat(parts);
}

module.exports = { build };
