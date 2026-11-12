# บันทึกประจำวัน (daily-health-log)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/monthop-gmail/daily-health-log)

เว็บแอปบันทึกกิจวัตรประจำวัน/สังเกตสุขภาพ เน้น **บันทึกเร็ว นึกได้ก็บันทึก** ใช้บนมือถือเป็นหลัก
รันบน **Cloudflare Workers + D1** (ใช้แผนฟรีได้) ไม่มีขั้นตอน build ฝั่งหน้าเว็บ

> A quick-entry daily routine & health log (Thai UI) for Cloudflare Workers + D1. Click the button above to deploy your own private copy.

ใครจะเอาไปใช้ กดปุ่ม **Deploy to Cloudflare** ด้านบนได้เลย แต่ละคนจะได้แอปและฐานข้อมูลของตัวเองในบัญชี Cloudflare ของตัวเอง
ข้อมูลไม่ปนกันและไม่ผ่านเจ้าของ repo นี้ — หนึ่งการ deploy ใช้งานได้หนึ่งคน (รหัสผ่านเดียว)

## ทำอะไรได้บ้าง

- **บันทึกด่วน** — แตะปุ่มหมวด (ยา อาหาร ดื่มน้ำ อาการ วัดค่า ขับถ่าย เข้านอน ตื่นนอน ออกกำลัง อารมณ์ จดไว้) → แตะคำที่ใช้บ่อย → บันทึก
  - เวลาเริ่มต้นคือ "ตอนกดบันทึก" มีปุ่มลัด 15/30 นาที, 1/2 ชม.ก่อน, ย้อนไป 1 วัน หรือเลือกวันเวลาเองได้ (บันทึกย้อนหลังได้ไม่จำกัด)
  - หมวด อาการ/อารมณ์ มี **ระดับ 1–5**
  - คำที่พิมพ์บ่อยจะขึ้นเป็นตัวเลือกให้อัตโนมัติ
  - ปุ่มหมวดแสดง **เวลาที่บันทึกล่าสุด** (เช่น ยา 08:15) ช่วยกันกินยาซ้ำ
- **แก้ไข / ลบ** — แตะรายการในไทม์ไลน์ ลบแล้วกด "เลิกทำ" ได้ มีปุ่ม "ซ้ำตอนนี้" สำหรับบันทึกแบบเดิมอีกครั้ง
- **ใช้ได้ตอนเน็ตหลุด** — บันทึกลงเครื่องก่อน แล้วส่งขึ้นเซิร์ฟเวอร์เองเมื่อกลับมาออนไลน์
- **สรุปสำหรับพบแพทย์** — เลือกช่วง 7/14/30/90 วันหรือกำหนดเอง ตารางจำนวนครั้งต่อวัน + รายละเอียดแยกตามหมวด/ตามวัน
  พิมพ์หรือบันทึกเป็น PDF และดาวน์โหลด CSV ได้
- **ตั้งค่าหมวด** — แก้ชื่อ ไอคอน คำที่ใช้บ่อย ลำดับ ซ่อนปุ่ม เพิ่มหมวดใหม่
- **สำรอง/นำเข้าข้อมูล** เป็น JSON และส่งออก CSV ทั้งหมด
- ติดตั้งเป็นแอปบนหน้าจอโฮมได้ (PWA) และรองรับโหมดมืด

## วิธี deploy

### แบบที่ 1: ปุ่ม Deploy to Cloudflare (ง่ายที่สุด)

1. กดปุ่มด้านบน แล้วล็อกอิน Cloudflare + GitHub
2. ตั้งรหัสผ่าน `APP_PASSWORD` (อย่างน้อย 8 ตัว) ตอนที่ระบบถาม
3. รอระบบสร้าง repo ในบัญชี GitHub ของคุณ สร้างฐานข้อมูล D1 สร้างตาราง และ deploy ให้

หลังจากนั้น push โค้ดเข้า repo ที่ได้มาเมื่อไร Cloudflare จะ deploy ให้เองอัตโนมัติ

### แบบที่ 2: deploy เองด้วย Wrangler

ต้องมี Node.js 20+ และบัญชี Cloudflare

```bash
npm ci
npx wrangler login

# 1) สร้างฐานข้อมูล D1 แล้วเอา database_id ไปใส่แทนค่าเดิมใน wrangler.jsonc
npx wrangler d1 create daily-health-log

# 2) ตั้งรหัสผ่านเข้าแอป (อย่างน้อย 8 ตัว)
npx wrangler secret put APP_PASSWORD

# 3) สร้างตาราง + deploy
npm run deploy
```

จะได้ URL แบบ `https://daily-health-log.<subdomain>.workers.dev` ถ้าจะใช้โดเมนตัวเอง เพิ่ม Custom Domain ได้ที่หน้า Worker ใน Cloudflare Dashboard

### แบบที่ 3: deploy อัตโนมัติด้วย GitHub Actions

ทำข้อ 1 ของแบบที่ 2 ก่อน (commit `database_id` ของคุณเข้า repo) แล้วตั้ง secrets ใน repo (Settings → Secrets and variables → Actions):

| Secret | | ค่า |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | จำเป็น | สร้างจาก template **Edit Cloudflare Workers** แล้วเพิ่มสิทธิ์ **Account → D1 → Edit** |
| `APP_PASSWORD` | แนะนำ | รหัสผ่านเข้าแอป (อย่างน้อย 8 ตัว) — workflow จะตั้งให้ Worker เอง |
| `CLOUDFLARE_ACCOUNT_ID` | ไม่บังคับ | ใส่เมื่อ token เข้าถึงได้หลาย account |
| `API_TOKEN` | ไม่บังคับ | token สำหรับบันทึกผ่าน API / Shortcuts |

push เข้า `main` (หรือกด Run workflow ในแท็บ Actions) แล้ว workflow `.github/workflows/deploy.yml` จะสร้างตารางที่ยังไม่มี deploy และตั้งรหัสผ่านให้
ถ้าไม่ได้ตั้ง `CLOUDFLARE_API_TOKEN` workflow จะข้ามการ deploy (ไม่ error) — ใช้คู่กับแบบที่ 1 ได้ไม่ชนกัน

## รันในเครื่อง

```bash
cp .dev.vars.example .dev.vars      # แล้วใส่ APP_PASSWORD (อย่างน้อย 8 ตัว)
npm run db:migrate:local
npm run dev                          # http://localhost:8787
```

## ใช้บนมือถือ

- **iPhone**: เปิดใน Safari → ปุ่มแชร์ → "เพิ่มไปยังหน้าจอโฮม"
- **Android**: เปิดใน Chrome → เมนู ⋮ → "ติดตั้งแอป" (กดค้างที่ไอคอนจะมีทางลัด บันทึกยา/อาการ/อาหาร/วัดค่า)
- ลิงก์ลัดเปิดหมวดตรง ๆ ได้ด้วย `/?add=<key>` เช่น `/?add=med`

ล็อกอินครั้งเดียวอยู่ได้ 180 วัน เปลี่ยน `APP_PASSWORD` เมื่อไร ทุกเครื่องจะต้องล็อกอินใหม่

## บันทึกผ่าน API (iOS Shortcuts / Siri / สคริปต์)

ตั้ง token ก่อน: `npx wrangler secret put API_TOKEN`

```bash
curl -X POST https://<your-worker>/api/entries \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"category":"ยา","text":"ยาเช้า"}'
```

`category` ใส่ได้ทั้งชื่อหมวด (เช่น `ยา`) หรือ key (เช่น `med`) · ใส่ `level` (1–5) และ `ts` (epoch ms) ได้ถ้าต้องการ
ใน iOS Shortcuts ใช้ action "Get Contents of URL" ด้วยค่าเดียวกัน แล้วตั้งให้เรียกผ่าน Siri ได้

## ความปลอดภัยและข้อมูล

- ทุก API ต้องล็อกอิน (cookie HttpOnly ที่เซ็นด้วย HMAC) หรือใช้ Bearer token
- แอปจะไม่ยอมให้ใช้งานถ้า `APP_PASSWORD` ว่าง สั้นกว่า 8 ตัว หรือเป็นค่าตัวอย่าง เช่น `change-me`
- กันเดารหัสผ่าน: ผิดเกิน 10 ครั้งใน 15 นาทีจะถูกล็อกชั่วคราว
- ถ้าต้องการชั้นป้องกันเพิ่ม เปิด **Cloudflare Access** (Zero Trust) ครอบโดเมนนี้ได้ ไม่ต้องแก้โค้ด
- ฟอนต์และไฟล์ทั้งหมดเสิร์ฟจาก Worker เอง ไม่มีการเรียกบริการภายนอก
- D1 มี Time Travel กู้ฐานข้อมูลย้อนหลังได้ (แผนฟรี 7 วัน / แผน Paid 30 วัน) และกด "สำรองข้อมูล (JSON)" ในหน้าตั้งค่าเก็บไว้เองได้
- ลบรายการเป็นแบบ soft delete (`deleted = 1`) ในฐานข้อมูล

## โครงสร้าง

```
src/index.ts              Worker: API + auth (เสิร์ฟหน้าเว็บผ่าน Static Assets)
migrations/0001_init.sql  ตาราง entries, settings, login_attempts
public/                   หน้าเว็บ (index.html, app.js, styles.css, sw.js, manifest, ไอคอน, ฟอนต์)
public/_headers           security headers (CSP ฯลฯ)
wrangler.jsonc            ค่าตั้ง Worker + D1
```

### API

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| POST | `/api/login` | `{password}` → ตั้ง cookie |
| POST | `/api/logout` | ออกจากระบบ |
| GET | `/api/entries?from=&to=&limit=` | รายการในช่วงเวลา (epoch ms) |
| POST | `/api/entries` | สร้างรายการเดียว (สำหรับ Shortcuts) |
| POST | `/api/sync` | `{ops:[{type:'put',entry} \| {type:'del',id,updated_at}]}` — ใช้โดยแอป (idempotent, last-write-wins) |
| GET | `/api/suggestions` | คำที่ใช้บ่อยของแต่ละหมวด |
| GET/PUT | `/api/categories` | ปุ่มหมวดบันทึกด่วน |
| POST | `/api/categories/reset` | คืนค่าหมวดเริ่มต้น |

## สัญญาอนุญาต

โค้ดใช้สัญญาอนุญาต MIT (ดู `LICENSE`) — นำไปใช้ แก้ไข หรือ deploy ต่อได้อิสระ
ฟอนต์ IBM Plex Sans Thai ใช้สัญญาอนุญาต SIL Open Font License 1.1 (ดู `public/fonts/OFL-LICENSE.txt`)

แอปนี้เป็นเครื่องมือจดบันทึกส่วนตัว ไม่ใช่อุปกรณ์ทางการแพทย์ และไม่ได้ให้คำแนะนำทางการแพทย์
