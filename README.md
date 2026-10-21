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

## ยังไม่ได้ทำ (ขั้นถัดไป)

- Login จริง (LINE Login, OTP) แทน `/v1/dev/login`
- เว็บ Next.js ตามดีไซน์แบบ D
- Backoffice ผู้จัดงาน, หน้างาน, ผลการแข่งขัน, แอดมิน, payout
- Rate limit / waiting room, ส่งอีเมลและ LINE, ทดสอบกับ Omise test keys จริง
