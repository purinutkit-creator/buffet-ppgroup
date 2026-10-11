'use strict';
// Usage: npm run setup            (interactive)
//        npm run setup -- --name "Papper international buffet" --branch BS --owner OWNER --pin 123456
const readline = require('readline');
const { setup } = require('../server/bootstrap');

function arg(n) { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; }
async function ask(rl, q, def) { return new Promise((r) => rl.question(`${q}${def ? ` (${def})` : ''}: `, (a) => r(a.trim() || def))); }

(async () => {
  let opts = { restaurantName: arg('name'), branchCode: arg('branch'), branchName: arg('branch-name'), ownerCode: arg('owner'), ownerPin: arg('pin'), ownerName: arg('owner-name'), taxId: arg('tax-id'), phone: arg('phone') };
  if (!opts.restaurantName || !opts.ownerCode || !opts.ownerPin) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    opts.restaurantName = await ask(rl, 'ชื่อร้าน', opts.restaurantName);
    opts.branchCode = (await ask(rl, 'รหัสสาขา', opts.branchCode || 'MAIN')).toUpperCase();
    opts.branchName = await ask(rl, 'ชื่อสาขา', opts.branchName || opts.restaurantName);
    opts.ownerCode = await ask(rl, 'รหัสพนักงานเจ้าของร้าน', opts.ownerCode || 'OWNER');
    opts.ownerName = await ask(rl, 'ชื่อเจ้าของร้าน', opts.ownerName || 'Owner');
    opts.ownerPin = await ask(rl, 'PIN (ตัวเลข 4-8 หลัก)', opts.ownerPin);
    rl.close();
  }
  try {
    const r = setup(opts);
    console.log('✔ ตั้งค่าเรียบร้อย', r);
    console.log(`เข้าสู่ระบบที่ /admin ด้วยรหัส ${opts.ownerCode}`);
  } catch (e) { console.error('✘', e.message); process.exit(1); }
})();
