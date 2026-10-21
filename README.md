# ก้าว (kao-run)

แพลตฟอร์มรับสมัครงานวิ่ง monorepo นี้มี API (NestJS) และจะมีเว็บ (Next.js) ตามมา

- `apps/api` NestJS + Fastify, PostgreSQL 16 ผ่าน Drizzle/pg, Redis + BullMQ
- `docs/` สเปกระบบ: `blueprint.html`, `openapi.yaml`, `schema.sql`

## เริ่มใช้งานในเครื่อง

```bash
docker compose up -d                 # PostgreSQL 16 + Redis 7
cp apps/api/.env.example apps/api/.env
# ใส่ค่า JWT_SECRET, PII_ENCRYPTION_KEY, PII_HASH_KEY ตามคำสั่งในไฟล์
pnpm install
pnpm db:migrate                      # รัน apps/api/db/migrations/*.sql
pnpm db:seed                         # งานตัวอย่าง Riverside Night Run 2027
pnpm dev:api                         # http://localhost:4000/v1
```

คำสั่ง db และ dev อ่านค่าจาก environment ให้ export ค่าใน `.env` ก่อน (เช่น `set -a; . apps/api/.env; set +a`)

## Flow ที่ใช้งานได้แล้ว

| ขั้น | Endpoint |
|---|---|
| ดูงาน | `GET /v1/events`, `GET /v1/events/:slug`, `GET /v1/events/:slug/availability` |
| เข้าสู่ระบบ (ชั่วคราว) | `POST /v1/dev/login` (เปิดเฉพาะ `ENABLE_DEV_ENDPOINTS=true`) |
| จองที่ 15 นาที | `POST /v1/checkout/sessions`, `GET`/`DELETE /v1/checkout/sessions/:id` |
| เลือก/เปลี่ยนไซซ์เสื้อ | `PUT /v1/checkout/sessions/:id/variants` (ก่อนสร้างคำสั่งซื้อ) |
| สร้างคำสั่งซื้อ | `POST /v1/orders` (ต้องส่ง `Idempotency-Key`) |
| ชำระเงิน | `POST /v1/orders/:id/payments` (`promptpay`, `card`, `mobile_banking`) |
| ยืนยันการจ่าย | `POST /v1/webhooks/payments/:gateway` |
| บัตรวิ่ง | `GET /v1/me/registrations`, `GET /v1/me/registrations/:id` |

## Backoffice ผู้จัดงาน

ทุก endpoint อยู่ใต้ `/v1/org/:orgId` และตรวจบทบาทของผู้เรียกในทีมผู้จัดทุกครั้ง คนนอกทีมได้ 404

| งาน | Endpoint | บทบาทที่ทำได้ |
|---|---|---|
| ทีมผู้จัดของฉัน | `GET /v1/org` | ทุกคน |
| รายการงาน, ภาพรวม (ยอดรายวัน โควต้า เสื้อ รายได้) | `GET .../events`, `GET .../events/:id/dashboard` | ทุกบทบาท |
| สร้าง/แก้งาน, เปิด/ปิดรับสมัคร | `POST .../events`, `PATCH .../events/:id`, `POST .../publish`, `POST .../close` | owner, admin |
| ระยะ, ช่วงราคา | `POST/PATCH/DELETE .../races/:raceId`, `.../price-tiers/:tierId` | owner, admin |
| ไซซ์เสื้อและสต็อก | `PUT .../events/:id/shirts` | owner, admin |
| คูปอง | `GET/POST .../coupons`, `PATCH .../coupons/:couponId` | owner, admin (ดูได้ทุกบทบาท) |
| ฟอร์มสมัคร: คำถามเพิ่มเติม | `GET/POST .../questions`, `PATCH/DELETE .../questions/:questionId`, `PUT .../questions/order` | owner, admin (ดูได้ทุกบทบาท) |
| ผู้สมัคร: ค้นหา, รายละเอียด | `GET .../events/:id/registrations`, `GET /v1/org/:orgId/registrations/:id` | ทุกบทบาท |
| Export CSV, ดูเลขบัตรเต็ม | `GET .../registrations.csv`, `POST .../registrations/:id/reveal-id-doc` | owner, admin |
| บิบ: ภาพรวมช่วงเลข, ให้เลขเอง, ออกเลขให้คนที่ยังไม่มี, นำเข้า CSV | `GET .../events/:id/bibs`, `PUT .../registrations/:registrationId/bib`, `POST .../bibs/assign`, `POST .../bibs/import` | owner, admin (ดูได้ทุกบทบาท) |
| รับเสื้อและบิบหน้างาน | `GET .../checkins/lookup?code=`, `POST .../checkins` | owner, admin, staff |
| ทีมงาน: เชิญ, เปลี่ยนบทบาท, นำออก | `GET/POST /v1/org/:orgId/members`, `PATCH/DELETE .../members/:memberId` | owner (ดูได้ทุกบทบาท) |

- **ไม่ลดเกินที่ขายไปแล้ว:** ลดโควต้าระยะ, โควต้าช่วงราคา หรือสต็อกเสื้อต่ำกว่าที่ขายหรือจองไว้ไม่ได้ ลบระยะหรือช่วงราคาที่มีคนซื้อแล้วก็ไม่ได้
- **บิบไม่ชนกัน:** ช่วงเลขบิบของแต่ละระยะในงานเดียวกันห้ามทับกัน และเปลี่ยนเลขเริ่มไม่ได้เมื่อออกบิบไปแล้ว
  - เลขบิบไม่ซ้ำกันทั้งงาน (`uq_registrations_event_bib`) ใส่เลขที่มีคนใช้แล้วได้ `BIB_TAKEN` พร้อมเลขสมัครของเจ้าของเลข
  - ออกบิบอัตโนมัติตอนชำระเงิน และปุ่มออกเลขให้คนที่ยังไม่มี ใช้ฟังก์ชันเดียวกัน (`modules/bibs/next-bib.ts`) ข้ามเลขที่ให้เองหรือนำเข้าไปแล้ว
  - ให้เลขเองได้เฉพาะผู้สมัครที่ชำระเงินแล้ว ใส่เลขนอกช่วงได้ (VIP / นักวิ่งรับเชิญ) อักษรอังกฤษ ตัวเลข - ไม่เกิน 10 ตัว
  - นำเข้า CSV (คอลัมน์ `registration_no`, `bib` เช่นไฟล์ Export ที่กรอก bib แล้ว) ตรวจทุกแถวก่อน มีแถวผิดแถวเดียวไม่บันทึกเลย สลับเลขกันในไฟล์ได้
- **เปิดรับสมัครได้เมื่อพร้อม:** ต้องมีข้อมูลงาน สถานที่ ช่วงเวลารับสมัคร อย่างน้อยหนึ่งระยะ ทุกระยะมีราคา และทีมผู้จัดผ่าน KYC แล้ว
  - ยังไม่มีขั้นแอดมินตรวจ ผู้จัดเปิดเองได้เลย
- **คูปอง:** ล็อกส่วนลดเมื่อมีคนใช้โค้ดแล้ว แต่ยังปิดใช้หรือปรับจำนวนสิทธิ์ได้
- **คำถามเพิ่มเติม:** ข้อความสั้น/ยาว, ตัวเลข (กำหนดช่วงได้), เลือกหนึ่งหรือหลายข้อ, ติ๊กยืนยัน, วันที่ ถามทุกระยะหรือเฉพาะบางระยะ งานละไม่เกิน 30 ข้อ
  - หน้างาน `GET /v1/events/:slug` ส่ง `questions` ให้ฟอร์มสมัคร และ `POST /v1/orders` ตรวจคำตอบของนักวิ่งแต่ละคนตามระยะ (ตอบไม่ครบหรือผิดได้ 422 พร้อม path `participants.N.answers.<key>`) แล้วเก็บใน `registrations.answers`
  - คำตอบแสดงในรายละเอียดผู้สมัครและเป็นคอลัมน์ใน CSV
  - มีคนตอบแล้วเปลี่ยนประเภทไม่ได้ (`QUESTION_IN_USE`) ลบคำถามที่มีคนตอบแล้วจะแค่ซ่อน คำตอบเดิมยังอยู่
  - ยังไม่รองรับคำถามแบบอัปโหลดไฟล์
- **PDPA:** รายละเอียดผู้สมัครแสดงเลขบัตรแบบปิดไว้ การกดดูเลขเต็มและการ Export ทุกครั้งบันทึกใน `audit_logs`
  - CSV ไม่มีเลขบัตรและข้อมูลสุขภาพ และกันสูตร Excel (`=`, `+`, `-`, `@`)
- **รับของหน้างาน:** สแกน QR บนบัตรวิ่ง หรือพิมพ์เลขบิบหรือเลขสมัคร
  - รับของได้ครั้งเดียว ถ้าเครื่องสแกนส่งซ้ำด้วย `clientUuid` เดิมจะไม่บันทึกซ้ำ
  - ผู้สมัครที่ยังไม่จ่ายรับของไม่ได้
- **ทีมงาน:** เชิญด้วยอีเมลและบทบาท คนที่ถูกเชิญเข้าทีมเองครั้งแรกที่ login ด้วยอีเมลนั้นแล้วเปิด `GET /v1/org` (ยังไม่มีลิงก์เชิญทางอีเมล)
  - ทีมต้องมี owner อย่างน้อยหนึ่งคนเสมอ ลดบทบาทหรือนำ owner คนสุดท้ายออกไม่ได้ (`LAST_OWNER`)
  - เชิญอีเมลซ้ำไม่ได้ (`ALREADY_INVITED`, `ALREADY_MEMBER`) ทุกการเชิญ ตอบรับ เปลี่ยนบทบาท และนำออก บันทึกใน `audit_logs`
- **ผู้จัดตัวอย่าง:** `pnpm db:seed` สร้างบัญชี `organizer@riverside.example` เป็น owner ของผู้จัด Riverside (login ผ่าน `/v1/dev/login`)

ตอนพัฒนาใช้ `PAYMENT_GATEWAY=fake` แล้วจำลองการจ่ายด้วย
`POST /v1/dev/fake-gateway/charges/:chargeId/complete` ซึ่งวิ่งผ่านโค้ดยืนยัน webhook ชุดเดียวกับของจริง

## หลักการสำคัญในโค้ด

- **ไม่ขายเกินโควต้า:** ทุกการจองใช้ `UPDATE ... WHERE sold + reserved + n <= capacity` ครั้งเดียว ใช้กับระยะ, ช่วงราคา (Early bird) และไซซ์เสื้อ
- **จองก่อน ตัดจริงทีหลัง:** checkout ย้ายจำนวนเข้า `reserved` เมื่อจ่ายสำเร็จจึงย้ายไป `sold` ถ้าหมดเวลา job คืนโควต้าทุก 30 วินาที
- **จ่ายช้าหลังหมดเวลา:** ถ้ายังมีที่ว่างจะยืนยันให้ ถ้าเต็มแล้วจะสร้างรายการคืนเงินอัตโนมัติ
- **Webhook ซ้ำไม่มีผล:** บันทึก `webhook_events (gateway, event_id)` แบบ unique ก่อนทำงาน
- **Omise:** ไม่เชื่อ body ที่ส่งมา ดึง event กลับจาก Omise API ด้วย secret key ทุกครั้ง
- **PDPA:** เลขบัตรประชาชน/พาสปอร์ตเข้ารหัส AES-256-GCM และใช้ HMAC สำหรับตรวจสมัครซ้ำ
- **เงินเป็นสตางค์ (integer) ทั้งระบบ**

## Test

```bash
pnpm --filter @kao/api test
```

test สร้างฐานข้อมูลชั่วคราวบน Postgres จริง (ค่าเริ่มต้น `postgres://postgres@127.0.0.1:5432/postgres`
เปลี่ยนได้ด้วย `TEST_DATABASE_ADMIN_URL`) รัน migration แล้วลบทิ้งเมื่อจบ ครอบคลุม:

- flow เต็มตั้งแต่ดูงานจนได้บัตรวิ่งพร้อมเลขบิบ, คูปอง, ค่าธรรมเนียม
- 120 คนแย่ง 25 ที่พร้อมกัน → ขายได้ 25 พอดี, Early bird 10 ที่พอดี; ไซซ์เสื้อไม่ขายเกิน
- หมดเวลาแล้วคืนโควต้า, จ่ายช้าแต่ยังมีที่, จ่ายช้าแต่เต็มแล้วคืนเงิน
- Idempotency-Key, สมัครซ้ำด้วยบัตรเดิม, อายุไม่ถึง, webhook ปลอม
- Omise adapter (mock HTTP)
- ฟอร์มสมัคร: สร้าง/เรียงคำถาม, ตรวจคำตอบตามระยะ, คำตอบในรายละเอียดและ CSV, ล็อกประเภทเมื่อมีคนตอบ
- backoffice: สิทธิ์ตามบทบาท, สร้างงานจนเปิดรับสมัคร, กันลดโควต้า/สต็อกเกินที่ขาย, บิบทับกัน, คูปอง, ค้นหา/Export/audit, รับของหน้างาน, ภาพรวม
- บิบ: ภาพรวม, ให้เลขเอง/ลบเลข, เลขซ้ำ, ออกเลขข้ามเลขที่มีคนใช้และหยุดเมื่อช่วงเต็ม, นำเข้า CSV (ตรวจทุกแถว, สลับเลข)
- ทีมงาน: เชิญแล้ว login เข้าทีม, เชิญซ้ำ, owner คนสุดท้าย (รวมสอง owner ลดบทบาทกันพร้อมกัน), ถอนคำเชิญ

## ยังไม่ได้ทำ (ขั้นถัดไป)

- Login จริง (LINE Login, OTP) แทน `/v1/dev/login`
- Backoffice ส่วนที่เหลือ: คำขอโอน/คืนเงิน, ผลการแข่งขัน, ส่งข่าว, การเงิน
- แอดมิน: ตรวจงานก่อนเปิด, อนุมัติ KYC ผู้จัด, payout
- Rate limit / waiting room, ส่งอีเมลและ LINE, ทดสอบกับ Omise test keys จริง
