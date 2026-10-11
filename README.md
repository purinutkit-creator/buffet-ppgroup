# ระบบบริหารจัดการร้านบุฟเฟต์ครบวงจร (Buffet Restaurant Management System)

ระบบเว็บ Full-Stack ใช้งานได้จริง: Admin หลังร้าน, POS, ผังโต๊ะ, แพ็กเกจบุฟเฟต์, สั่งอาหารผ่าน QR Code (QR ต่อรอบการใช้โต๊ะ), เว็บไซต์ลูกค้า 3 ภาษา, สมาชิกและคะแนน, Kitchen Display (KDS), Staff Call Center, เครื่องพิมพ์ Thermal, การชำระเงิน, รายงาน และ Theme & Design Studio โดยทุกส่วนเชื่อมข้อมูลกันแบบ Real-Time

## เริ่มต้นใช้งาน

ต้องมี Node.js 20 ขึ้นไป

```bash
npm install
npm run setup          # สร้างร้าน สาขาแรก บทบาทระบบ และบัญชีเจ้าของร้าน (ถามทีละข้อ)
npm start              # http://localhost:3000
```

ถ้าต้องการข้อมูลตัวอย่างไว้ทดลอง (โต๊ะ แพ็กเกจ DELIGHT/HAPPINESS/PREMIUM/GRAND เมนูพร้อมรูปตัวอย่าง พนักงานทุกบทบาท):

```bash
npm run seed:demo      # OWNER/123456, M01/1111 (manager), C01/2222 (cashier), W01/3333 (waiter), K01/4444 (kitchen)
```

> ข้อมูลตัวอย่างใช้สำหรับทดลองเท่านั้น ลบหรือแก้ไขได้จากหน้า Admin ก่อนเปิดใช้งานจริง

| หน้า | URL | ผู้ใช้ |
|---|---|---|
| หน้ารวมแอป | `/` | – |
| POS / แคชเชียร์ | `/pos/` | Cashier, Waiter, Manager |
| Kitchen Display | `/kds/` | Kitchen |
| Staff Call Center | `/staff/` | Waiter |
| Admin หลังร้าน | `/admin/` | Owner, Admin, Manager |
| Print Station (USB/Bluetooth ผ่านเบราว์เซอร์) | `/print-station/` | เครื่องที่ต่อเครื่องพิมพ์ |
| เว็บลูกค้า | `/t/<token>` | เข้าได้จาก QR ที่พิมพ์ตอนเปิดโต๊ะเท่านั้น |

## สถาปัตยกรรม

```
Browser apps (vanilla JS, ไม่มี build step)  ──HTTP/JSON──►  Express 5 API  ──►  SQLite (better-sqlite3, WAL)
        ▲                                                  │
        └──────────── Socket.IO (real-time) ◄──────────────┤
                                                           ├──►  Print service: เรนเดอร์ใบพิมพ์เป็นภาพ (Skia) → ESC/POS raster
                                                           │        ├─ LAN printer (TCP 9100) ส่งตรงจากเซิร์ฟเวอร์
                                                           │        ├─ Local Print Bridge (USB / Serial / CUPS)
                                                           │        └─ Browser Print Station (WebUSB / Web Serial / Web Bluetooth)
                                                           └──►  Scheduler: แจ้งเตือนเวลา, คะแนนหมดอายุ, สำรองข้อมูลอัตโนมัติ
```

```
server/
  index.js            เริ่มเซิร์ฟเวอร์, security headers, static, /media, /theme.css
  db.js               schema ทั้งหมด (Restaurants, Branches, Tables, TableSessions, BuffetPackages, PackagePrices, MenuItems,
                      Categories, Orders, OrderItems, KitchenTickets, Members, PointTransactions, Promotions, Staff, Roles,
                      Payments, Bills, Printers, PrintJobs, StaffCalls, Themes, MediaAssets, AuditLogs ...)
  auth.js             รหัสพนักงาน + PIN (bcrypt), token, สิทธิ์, Manager Approval, Audit Log
  realtime.js         Socket.IO rooms: staff / kds / session / printers
  routes/             customer (ใช้ token ของโต๊ะ), pos, kds, admin, auth, printbridge
  services/           sessions, orders, pricing, payments, members, calls, printing, theme, media, reports, scheduler
  print/              documents (เลย์เอาต์ใบพิมพ์), render (Bitmap + ตัดคำไทย), escpos, fonts
public/               order (ลูกค้า), pos, kds, staff, admin, print-station, shared
print-bridge/         Local Print Bridge (Node.js ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
scripts/              setup, seed-demo, backup, restore
tests/                ทดสอบ Workflow ตั้งแต่เปิดโต๊ะจนปิดโต๊ะ + ฟีเจอร์อื่น
```

เงินทุกจำนวนเก็บเป็นสตางค์ (integer) เวลาเก็บเป็น epoch ms ตามนาฬิกาเซิร์ฟเวอร์ (ตัวจับเวลา KDS/ลูกค้าซิงก์กับเวลาเซิร์ฟเวอร์)

## การตั้งค่า (Environment)

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `PORT` | 3000 | พอร์ต |
| `PUBLIC_URL` | (จาก request ล่าสุด) | URL ที่ลูกค้าเข้าถึงได้ ใช้สร้าง QR เช่น `https://order.myshop.com` **ควรตั้งเสมอในการใช้งานจริง** |
| `DATA_DIR` | `./data` | ที่เก็บฐานข้อมูล รูป ฟอนต์ และไฟล์สำรอง |
| `APP_SECRET` | สร้างอัตโนมัติใน `data/.secret` | ใช้เข้ารหัส token ของ QR ที่เก็บในฐานข้อมูล |
| `OTP_MODE` | `dev` | `webhook` = ส่ง OTP ผ่าน SMS gateway, `dev` = แสดงรหัสบนหน้าจอ (ทดสอบเท่านั้น) |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | – | ระบบจะ POST `{phone, message, code}` ไปยัง URL นี้ (ต่อกับผู้ให้บริการ SMS ใดก็ได้) |
| `GOOGLE_FONTS_API_KEY` | – | เปิดการค้นหาฟอนต์ Google ทั้งแคตตาล็อก (ไม่ตั้ง = รายการแนะนำ + พิมพ์ชื่อฟอนต์เองได้) |
| `AUTO_BACKUP_HOURS`, `BACKUP_KEEP` | 24, 14 | รอบสำรองข้อมูลอัตโนมัติ และจำนวนไฟล์ที่เก็บ |
| `STAFF_TOKEN_HOURS` | 14 | อายุการเข้าสู่ระบบของพนักงาน |
| `TRUST_PROXY` | – | ตั้ง `1` เมื่อรันหลัง reverse proxy (nginx / Cloudflare) |

ใช้งานจริงควรรันหลัง HTTPS (จำเป็นสำหรับ WebUSB/Bluetooth และกล้องสแกน) เช่น nginx/Caddy → `node server/index.js` ด้วย systemd หรือ pm2

## ระบบ QR Code ต่อรอบการใช้โต๊ะ

* เปิดโต๊ะ = สร้าง Table Session ใหม่ พร้อม token สุ่ม 192 bit ที่ไม่เกี่ยวกับหมายเลขโต๊ะ (เก็บ hash สำหรับค้นหา และเก็บแบบเข้ารหัส AES-GCM ไว้พิมพ์ซ้ำ)
* QR ใช้ได้ตลอดรอบ แชร์ให้ผู้ร่วมโต๊ะได้ (ปุ่ม "แชร์ QR ให้เพื่อน")
* ทุก API ของลูกค้าตรวจสถานะ session ที่เซิร์ฟเวอร์ทุกครั้ง: หมดเวลาสั่ง → 409, อยู่ระหว่างชำระเงิน → 409, ปิดโต๊ะ → 410 "โต๊ะนี้สิ้นสุดการให้บริการแล้ว"
* ปิดโต๊ะ: ยกเลิกสิทธิ์ทันที ตัดการเชื่อมต่อ real-time ของทุกอุปกรณ์ เปิดโต๊ะเดิมรอบใหม่ได้ QR และ Session ใหม่ทั้งหมด
* "QR ใหม่" ใน POS ยกเลิก QR เดิมทันที (กรณี QR หลุด)
* รวมโต๊ะ: QR ของโต๊ะที่ถูกรวมยังพาไปยังโต๊ะปลายทาง • แยกโต๊ะ: ได้ Session + QR ใหม่

## การสั่งอาหาร (ตรวจสอบที่ Backend ทั้งหมด)

สิทธิ์แพ็กเกจของแต่ละคน, สถานะเมนู, ช่วงเวลาที่สั่งได้, จำนวนสูงสุดต่อครั้ง/ต่อคน/ต่อโต๊ะ, จำนวนต่อรอบ, ระยะห่างระหว่างรอบ, ตัวเลือกที่บังคับเลือก, เวลาปิดรับออเดอร์ และ **Idempotency Key** (กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ได้ออเดอร์เดียว) ทั้งหมดทำใน transaction เดียว

โต๊ะที่ลูกค้าแต่ละคนเลือกแพ็กเกจต่างกัน: ลูกค้าเลือก "คุณ A / คุณ B" ที่ปุ่มโต๊ะ แล้วเห็นเฉพาะเมนูในแพ็กเกจของตัวเอง

## ราคาและบิล

* ราคาตามช่วงอายุ/ส่วนสูง ไม่จำกัดจำนวนกฎ ระบบตรวจช่วงทับซ้อน (ซ้อนได้เมื่อกำหนด Priority ต่างกัน)
* ลำดับคำนวณ: ค่าแพ็กเกจ + อาหารเพิ่ม + ค่าปรับเกินเวลา/อาหารเหลือ − ส่วนลด (โปรโมชั่นตาม Priority; โปรที่ใช้ร่วมไม่ได้จะไม่ซ้อนกัน แล้วจึงส่วนลดพนักงาน) → Service Charge → VAT (เลือกได้ว่าราคารวม VAT หรือไม่)
* ตัวอย่างตามใบเสร็จอ้างอิง: 5 × 999 = 4,995.00 + SC 10% 499.50 → VAT 7% 384.62 → **5,879.12** (มีในชุดทดสอบ)
* Split Bill (เท่ากัน / ตามลูกค้า / กำหนดยอด) ทุกองค์ประกอบภาษีถูกแบ่งให้รวมกันได้ตรงยอด • Split Payment หลายช่องทางในบิลเดียว
* ชำระเงิน + ปิดโต๊ะ + ยกเลิก QR + บันทึกยอด + สะสมคะแนน อยู่ใน **database transaction เดียว**
* พร้อมเพย์: สร้าง QR ตามมาตรฐาน Thai QR (EMVCo) พร้อมยอดเงิน — การยืนยันว่าเงินเข้าทำโดยแคชเชียร์ (ยังไม่ได้เชื่อม API ธนาคาร/payment gateway) บัตรเครดิตบันทึกยอดจากเครื่อง EDC
* ใบกำกับภาษีเต็มรูป (ชื่อ/เลข 13 หลัก/สาขา/ที่อยู่) และคืนเงิน (ต้องมี Manager Approval, หักคะแนนตามสัดส่วน)

## เครื่องพิมพ์

ทุกเอกสารถูกเรนเดอร์เป็นภาพขาวดำด้วยฟอนต์จริง (ค่าเริ่มต้น Sarabun ซึ่งรวมมาในระบบ, เลือก Google Font หรืออัปโหลดฟอนต์เองได้) แล้วส่งเป็นคำสั่ง ESC/POS raster จึง **พิมพ์ภาษาไทย/จีนได้กับเครื่องที่ไม่มีฟอนต์ไทย** รองรับ 58 มม. (384 dots) และ 80 มม. (576 dots)

| วิธีเชื่อมต่อ | ใช้เมื่อ | การตั้งค่า |
|---|---|---|
| Network (LAN) | เครื่องพิมพ์มีพอร์ต LAN/Wi-Fi อยู่วงเดียวกับเซิร์ฟเวอร์ | ใส่ `IP:9100` ในหน้า Admin › เครื่องพิมพ์ แล้วกด "ตรวจสอบการเชื่อมต่อ" |
| Local Print Bridge | USB / Serial / CUPS / LAN คนละวงกับเซิร์ฟเวอร์ (เช่นเซิร์ฟเวอร์อยู่บน Cloud) | `node print-bridge/bridge.js --server https://… --key pb_… --target file:/dev/usb/lp0` (ดู target อื่นในไฟล์) |
| Browser Print Station | แท็บเล็ต/คอมพิวเตอร์ที่ใช้ Chrome/Edge ต่อเครื่องพิมพ์ USB หรือ Bluetooth | เปิด `/print-station/` กดเชื่อมต่อ และเปิดหน้านั้นค้างไว้ (iOS/Safari ไม่รองรับ WebUSB/Bluetooth — ใช้ LAN หรือ Bridge แทน) |

* กำหนดเครื่องพิมพ์ต่อเอกสาร: ใบ QR เปิดโต๊ะ, ใบสมัครสมาชิก, ใบครัว, ใบเสร็จ, ใบสรุปปิดโต๊ะ, ใบกำกับภาษี — ใช้เครื่องเดียวกันทั้งหมดได้ (ปุ่ม "ใช้ Printer A กับทุกเอกสาร")
* Print Queue: Pending → Printing → Printed / Failed (ลองซ้ำอัตโนมัติ 3 ครั้ง, ส่งงานทีละงานต่อเครื่อง, พิมพ์ซ้ำได้) สถานะมาจากผลการส่งจริงเท่านั้น
* ใบครัวพิมพ์เฉพาะรายการของออเดอร์ใหม่ และแยกตามสถานี (หรือเครื่องที่กำหนดในเมนู)
* ใบ QR ที่พิมพ์ซ้ำหลังปิดโต๊ะจะไม่มี QR (แสดง "QR นี้สิ้นสุดการใช้งานแล้ว")

## สมาชิก

สมัครที่เคาน์เตอร์ (POS) หรือลูกค้าสแกนใบสมัครสมาชิกที่พิมพ์ตอนเปิดโต๊ะ → ยืนยันเบอร์ด้วย OTP → ผูกกับโต๊ะปัจจุบันทันที • Tier, อัตราสะสม, ตัวคูณ, คะแนนหมดอายุ (ตัดแบบ FIFO), โบนัสสมัคร/วันเกิด, โปรโมชั่นแลกส่วนลด/อาหารฟรี/อัปเกรดแพ็กเกจ จำกัดตาม Tier/สาขา/วัน/เวลา/โควตา, รหัสแลกใช้ครั้งเดียว, ยกเลิกแล้วคืนคะแนน • คะแนนจากยอดขายเพิ่มหลังชำระเงินสำเร็จเท่านั้น

## ความปลอดภัย

PIN เก็บแบบ bcrypt (ล็อก 5 นาทีเมื่อผิด 5 ครั้ง) • สิทธิ์ตรวจที่เซิร์ฟเวอร์ทุก endpoint • Manager Approval สำหรับคืนเงิน/ปรับคะแนน/ส่วนลดเกินเกณฑ์/ยกเลิกรายการที่เสิร์ฟแล้ว (ตั้งค่าได้) • Audit Log ทุกการเปลี่ยนแปลงสำคัญ • Rate limit (ล็อกอิน, OTP, ออเดอร์, เรียกพนักงาน) • HTML เงื่อนไขบริการผ่าน allow-list sanitizer • อัปโหลดตรวจ magic bytes, SVG ที่มี script/ลิงก์ภายนอกถูกปฏิเสธ และเสิร์ฟพร้อม CSP • ค่าธีมถูก validate ก่อนสร้าง CSS • ไม่ส่ง token/ข้อมูลส่วนบุคคลให้ลูกค้าเกินจำเป็น (เบอร์โทรถูก mask)

## สำรองและกู้คืนข้อมูล

* อัตโนมัติทุก `AUTO_BACKUP_HOURS` ชั่วโมงไปที่ `data/backups` • สั่งเองได้ที่ Admin › สำรองข้อมูล หรือ `npm run backup`
* กู้คืน: หยุดเซิร์ฟเวอร์ → `npm run restore -- data/backups/<file>.db` (ตรวจ integrity และเก็บไฟล์เดิมไว้)
* รูปภาพ/ฟอนต์อยู่ที่ `data/uploads` ควรสำรองด้วย

## การทดสอบ

```bash
npm test
```

`tests/workflow.test.js` ทดสอบสถานการณ์ตามเกณฑ์ส่งมอบครบทุกข้อ ด้วยเซิร์ฟเวอร์จริง ฐานข้อมูลจริง Socket.IO จริง และเครื่องพิมพ์ LAN จำลอง (TCP server ที่รับไบต์ ESC/POS): เปิดโต๊ะ 7 ลูกค้า 5 คน HAPPINESS COURSE → คำนวณเวลาและยอด 5,879.12 → พิมพ์ใบ QR + ใบสมัครสมาชิก → ลูกค้าสั่งอาหาร (ตรวจสิทธิ์/ซ้ำ) → ครัวได้รับทันที → ครัวเปลี่ยนสถานะ ลูกค้าเห็นทันที → เรียกพนักงาน → สมัครสมาชิก + แลกโปรโมชั่น → ชำระเงิน ปิดโต๊ะ พิมพ์ใบเสร็จ → QR เดิมใช้ไม่ได้ → เปิดโต๊ะ 7 ใหม่ได้ QR/Session ใหม่ → คืนเงินพร้อมอนุมัติ → ธีมแสดงผลจริงใน CSS → รายงานและส่งออก CSV/Excel/PDF

`tests/features.test.js` ทดสอบสิทธิ์ตามบทบาท, Split Bill/Split Payment, รวมโต๊ะ, Print Bridge, Print Station, เครื่องพิมพ์ออฟไลน์ (ต้องล้มเหลวจริง ไม่ขึ้นสำเร็จปลอม), การตรวจไฟล์อัปโหลด และ sanitizer

## ข้อจำกัดที่ควรทราบ

* ฐานข้อมูล SQLite เหมาะกับร้าน/หลายสาขาที่ใช้เซิร์ฟเวอร์กลางเครื่องเดียว (รองรับหลายอุปกรณ์พร้อมกัน) หากต้องการหลายเซิร์ฟเวอร์ (horizontal scaling) ต้องย้ายไป PostgreSQL และใช้ Socket.IO adapter
* OTP ต้องเชื่อม SMS gateway ผ่าน `SMS_WEBHOOK_URL` เอง (โหมด `dev` แสดงรหัสบนหน้าจอเพื่อทดสอบเท่านั้น)
* การรับชำระพร้อมเพย์/บัตร ยืนยันโดยพนักงาน ยังไม่ได้เชื่อม payment gateway
* หน้าลูกค้ารองรับไทย/อังกฤษ/จีน ส่วนหน้าพนักงาน (POS/KDS/Admin) เป็นภาษาไทย ชื่อเมนู/แพ็กเกจ/ปุ่มต่าง ๆ กรอกได้ 3 ภาษา
* WebUSB / Web Bluetooth ใช้ได้เฉพาะ Chrome/Edge บน HTTPS (หรือ localhost)

ฟอนต์ Sarabun © The Sarabun Project Authors — SIL Open Font License 1.1 (`server/assets/fonts/OFL.txt`)
