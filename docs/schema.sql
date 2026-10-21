-- =====================================================================
-- Running Event Platform — PostgreSQL 16 schema
-- เงินทุกช่อง = สตางค์ (BIGINT), เวลา = timestamptz, PK = UUID
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =====================================================================
-- ENUMS
-- =====================================================================
CREATE TYPE user_status          AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE platform_role        AS ENUM ('user', 'support', 'finance', 'admin', 'superadmin');
CREATE TYPE auth_provider        AS ENUM ('password', 'line', 'google', 'facebook', 'apple', 'phone_otp', 'email_otp');
CREATE TYPE gender               AS ENUM ('male', 'female', 'other');
CREATE TYPE id_doc_type          AS ENUM ('thai_id', 'passport');
CREATE TYPE blood_type           AS ENUM ('A', 'B', 'AB', 'O', 'unknown');
CREATE TYPE org_status           AS ENUM ('pending_kyc', 'active', 'suspended');
CREATE TYPE org_role             AS ENUM ('owner', 'admin', 'finance', 'staff', 'viewer');
CREATE TYPE kyc_doc_type         AS ENUM ('company_certificate', 'vat_registration', 'id_card', 'bank_book', 'other');
CREATE TYPE kyc_status           AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE event_status         AS ENUM ('draft', 'pending_review', 'published', 'closed', 'cancelled');
CREATE TYPE event_type           AS ENUM ('road', 'trail', 'virtual', 'ultra', 'fun_run');
CREATE TYPE age_basis            AS ENUM ('race_day', 'birth_year', 'year_end');
CREATE TYPE product_type         AS ENUM ('shirt', 'medal', 'shipping', 'insurance', 'photo', 'donation', 'other');
CREATE TYPE question_type        AS ENUM ('text', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date', 'file');
CREATE TYPE discount_type        AS ENUM ('percent', 'fixed');
CREATE TYPE checkout_status      AS ENUM ('active', 'converted', 'expired', 'abandoned');
CREATE TYPE hold_status          AS ENUM ('held', 'committed', 'released');
CREATE TYPE order_status         AS ENUM ('pending_payment', 'paid', 'expired', 'cancelled', 'partially_refunded', 'refunded');
CREATE TYPE order_item_type      AS ENUM ('race', 'product', 'donation', 'fee', 'transfer_fee', 'change_fee');
CREATE TYPE payment_method       AS ENUM ('promptpay', 'card', 'mobile_banking', 'bank_transfer', 'manual', 'free');
CREATE TYPE payment_status       AS ENUM ('pending', 'authorized', 'succeeded', 'failed', 'expired', 'refunded', 'partially_refunded');
CREATE TYPE refund_status        AS ENUM ('requested', 'approved', 'rejected', 'processing', 'succeeded', 'failed');
CREATE TYPE registration_status  AS ENUM ('pending', 'confirmed', 'cancelled', 'transferred', 'refunded');
CREATE TYPE registration_source  AS ENUM ('online', 'manual', 'comp', 'import', 'transfer', 'waitlist');
CREATE TYPE transfer_status      AS ENUM ('pending', 'accepted', 'completed', 'rejected', 'expired', 'cancelled');
CREATE TYPE race_change_status   AS ENUM ('pending_payment', 'completed', 'rejected', 'cancelled');
CREATE TYPE waitlist_status      AS ENUM ('waiting', 'offered', 'converted', 'expired', 'cancelled');
CREATE TYPE checkin_type         AS ENUM ('kit_pickup', 'race_start', 'shipping');
CREATE TYPE result_status        AS ENUM ('FIN', 'DNF', 'DNS', 'DQ');
CREATE TYPE notification_channel AS ENUM ('email', 'line', 'sms', 'push', 'in_app');
CREATE TYPE notification_status  AS ENUM ('queued', 'sent', 'delivered', 'failed', 'read');
CREATE TYPE broadcast_status     AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'cancelled');
CREATE TYPE consent_purpose      AS ENUM ('terms', 'privacy', 'registration_data', 'share_with_organizer', 'marketing', 'health_data', 'photo');
CREATE TYPE tax_invoice_status   AS ENUM ('issued', 'cancelled', 'replaced');
CREATE TYPE settlement_status    AS ENUM ('open', 'calculated', 'approved', 'paid', 'void');
CREATE TYPE payout_status        AS ENUM ('pending', 'processing', 'paid', 'failed');
CREATE TYPE cms_status           AS ENUM ('draft', 'published', 'archived');
CREATE TYPE actor_type           AS ENUM ('user', 'staff', 'system', 'admin', 'webhook');

-- =====================================================================
-- USERS & AUTH
-- =====================================================================
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE,
  phone           TEXT UNIQUE,
  password_hash   TEXT,
  display_name    TEXT,
  avatar_url      TEXT,
  locale          TEXT NOT NULL DEFAULT 'th' CHECK (locale IN ('th', 'en')),
  platform_role   platform_role NOT NULL DEFAULT 'user',
  status          user_status NOT NULL DEFAULT 'active',
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE auth_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         auth_provider NOT NULL,
  provider_user_id TEXT NOT NULL,          -- LINE userId / Google sub / เบอร์โทร
  access_token_enc BYTEA,                  -- เข้ารหัสระดับ application
  refresh_token_enc BYTEA,
  profile          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX idx_auth_identities_user ON auth_identities(user_id);

CREATE TABLE otp_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target       TEXT NOT NULL,              -- email หรือเบอร์โทร
  code_hash    TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('login', 'verify', 'reset_password')),
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_codes_target ON otp_codes(target, created_at DESC);

CREATE TABLE user_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  user_agent         TEXT,
  ip                 INET,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

-- โปรไฟล์นักวิ่ง: ของตัวเอง + เพื่อน/ครอบครัว (is_self)
CREATE TABLE runner_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_self             BOOLEAN NOT NULL DEFAULT false,
  first_name_th       TEXT,
  last_name_th        TEXT,
  first_name_en       TEXT NOT NULL,
  last_name_en        TEXT NOT NULL,
  nickname            TEXT,
  gender              gender NOT NULL,
  birth_date          DATE NOT NULL,
  nationality         CHAR(2) NOT NULL DEFAULT 'TH',   -- ISO 3166-1 alpha-2
  id_doc_type         id_doc_type NOT NULL,
  id_doc_number_enc   BYTEA NOT NULL,                  -- เข้ารหัส (AES-GCM / KMS)
  id_doc_hash         TEXT NOT NULL,                   -- HMAC สำหรับตรวจซ้ำ
  id_doc_last4        TEXT,
  email               CITEXT,
  phone               TEXT,
  blood_type          blood_type NOT NULL DEFAULT 'unknown',
  medical_conditions_enc BYTEA,                        -- ข้อมูลสุขภาพ (PDPA sensitive)
  emergency_name      TEXT,
  emergency_phone     TEXT,
  emergency_relation  TEXT,
  shirt_size          TEXT,
  address             JSONB,                           -- ที่อยู่จัดส่ง
  club_name           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CHECK (birth_date > DATE '1900-01-01')
);
CREATE INDEX idx_runner_profiles_owner ON runner_profiles(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_runner_profiles_doc_hash ON runner_profiles(id_doc_hash);
CREATE UNIQUE INDEX uq_runner_profiles_self ON runner_profiles(owner_user_id) WHERE is_self AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_runner_profiles_owner_doc ON runner_profiles(owner_user_id, id_doc_hash) WHERE deleted_at IS NULL;

-- =====================================================================
-- ORGANIZATIONS
-- =====================================================================
CREATE TABLE organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             CITEXT NOT NULL UNIQUE,
  name_th          TEXT NOT NULL,
  name_en          TEXT,
  legal_name       TEXT,
  tax_id           TEXT,
  is_vat_registered BOOLEAN NOT NULL DEFAULT false,
  logo_url         TEXT,
  description      TEXT,
  contact_email    CITEXT,
  contact_phone    TEXT,
  website_url      TEXT,
  social_links     JSONB NOT NULL DEFAULT '{}',
  address          JSONB,
  status           org_status NOT NULL DEFAULT 'pending_kyc',
  kyc_approved_at  TIMESTAMPTZ,
  kyc_approved_by  UUID REFERENCES users(id),
  review_events    BOOLEAN NOT NULL DEFAULT true,   -- งานแรกต้องรอแอดมินตรวจก่อนเปิดรับสมัคร
  status_note      TEXT,                            -- เหตุผลที่ระงับ / ส่ง KYC กลับ
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{13}$')
);
CREATE INDEX idx_organizations_name_trgm ON organizations USING gin (name_th gin_trgm_ops);

CREATE TABLE org_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  invited_email   CITEXT,
  role            org_role NOT NULL,
  invited_by      UUID REFERENCES users(id),
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE UNIQUE INDEX uq_org_members_invite ON org_members(organization_id, invited_email) WHERE accepted_at IS NULL;

CREATE TABLE bank_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_code           TEXT NOT NULL,           -- เช่น KBANK, SCB, BBL
  account_name        TEXT NOT NULL,
  account_number_enc  BYTEA NOT NULL,
  account_number_last4 TEXT NOT NULL,
  branch              TEXT,
  is_default          BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_bank_accounts_default ON bank_accounts(organization_id) WHERE is_default;

CREATE TABLE organizer_kyc_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doc_type        kyc_doc_type NOT NULL,
  file_url        TEXT NOT NULL,
  status          kyc_status NOT NULL DEFAULT 'pending',
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_docs_org ON organizer_kyc_documents(organization_id);
CREATE INDEX idx_kyc_docs_pending ON organizer_kyc_documents(created_at) WHERE status = 'pending';

-- ค่าธรรมเนียมแพลตฟอร์ม: organization_id NULL = ค่า default ทั้งระบบ
CREATE TABLE platform_fees (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID REFERENCES organizations(id) ON DELETE CASCADE,
  percent_bps            INTEGER NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000), -- 250 = 2.5%
  fixed_per_reg_satang   BIGINT NOT NULL DEFAULT 0 CHECK (fixed_per_reg_satang >= 0),
  pass_fee_to_runner     BOOLEAN NOT NULL DEFAULT false,
  effective_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to           TIMESTAMPTZ,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX idx_platform_fees_org ON platform_fees(organization_id, effective_from DESC);

-- =====================================================================
-- EVENTS / RACES / PRICING
-- =====================================================================
CREATE TABLE events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  slug                CITEXT NOT NULL UNIQUE,
  name_th             TEXT NOT NULL,
  name_en             TEXT,
  summary_th          TEXT,
  summary_en          TEXT,
  description_th      TEXT,
  description_en      TEXT,
  rules_th            TEXT,
  rules_en            TEXT,
  refund_policy_th    TEXT,
  refund_policy_en    TEXT,
  faq                 JSONB NOT NULL DEFAULT '[]',
  schedule            JSONB NOT NULL DEFAULT '[]',     -- ตารางเวลา
  event_type          event_type NOT NULL DEFAULT 'road',
  status              event_status NOT NULL DEFAULT 'draft',
  timezone            TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  event_date          DATE NOT NULL,
  event_end_date      DATE,
  province_code       TEXT,
  venue_name          TEXT,
  venue_address       TEXT,
  lat                 NUMERIC(9,6),
  lng                 NUMERIC(9,6),
  cover_image_url     TEXT,
  gallery             JSONB NOT NULL DEFAULT '[]',
  shirt_size_chart    JSONB,
  registration_opens_at  TIMESTAMPTZ,
  registration_closes_at TIMESTAMPTZ,
  allow_transfer      BOOLEAN NOT NULL DEFAULT false,
  transfer_fee_satang BIGINT NOT NULL DEFAULT 0 CHECK (transfer_fee_satang >= 0),
  transfer_deadline   TIMESTAMPTZ,
  allow_race_change   BOOLEAN NOT NULL DEFAULT false,
  race_change_fee_satang BIGINT NOT NULL DEFAULT 0 CHECK (race_change_fee_satang >= 0),
  race_change_deadline TIMESTAMPTZ,
  allow_refund        BOOLEAN NOT NULL DEFAULT false,
  refund_deadline     TIMESTAMPTZ,
  refund_percent_bps  INTEGER NOT NULL DEFAULT 0 CHECK (refund_percent_bps BETWEEN 0 AND 10000),
  waitlist_enabled    BOOLEAN NOT NULL DEFAULT false,
  use_waiting_room    BOOLEAN NOT NULL DEFAULT false,
  hold_minutes        SMALLINT NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 5 AND 120),
  is_featured         BOOLEAN NOT NULL DEFAULT false,
  results_published_at TIMESTAMPTZ,
  submitted_at        TIMESTAMPTZ,
  reviewed_by         UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  review_note         TEXT,
  published_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (event_end_date IS NULL OR event_end_date >= event_date),
  CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL
         OR registration_closes_at > registration_opens_at)
);
CREATE INDEX idx_events_pending_review ON events(submitted_at) WHERE status = 'pending_review';
CREATE INDEX idx_events_org ON events(organization_id);
CREATE INDEX idx_events_public ON events(status, event_date) WHERE status IN ('published', 'closed');
CREATE INDEX idx_events_province_date ON events(province_code, event_date) WHERE status = 'published';
CREATE INDEX idx_events_type_date ON events(event_type, event_date) WHERE status = 'published';
CREATE INDEX idx_events_featured ON events(event_date) WHERE is_featured AND status = 'published';
CREATE INDEX idx_events_name_th_trgm ON events USING gin (name_th gin_trgm_ops);
CREATE INDEX idx_events_name_en_trgm ON events USING gin (name_en gin_trgm_ops);

-- ระยะการแข่งขัน
CREATE TABLE races (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,                    -- เช่น 42K, 10K
  name_th          TEXT NOT NULL,
  name_en          TEXT,
  distance_km      NUMERIC(6,2) NOT NULL CHECK (distance_km > 0),
  elevation_gain_m INTEGER,
  start_at         TIMESTAMPTZ,
  cutoff_minutes   INTEGER CHECK (cutoff_minutes > 0),
  capacity         INTEGER NOT NULL CHECK (capacity >= 0),
  reserved         INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),  -- ถูก hold ไว้ใน checkout
  sold             INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),      -- จ่ายแล้ว
  age_min          SMALLINT CHECK (age_min >= 0),
  age_max          SMALLINT,
  age_basis        age_basis NOT NULL DEFAULT 'race_day',
  gender_restriction gender,
  bib_prefix       TEXT,
  bib_start        INTEGER CHECK (bib_start >= 0),
  bib_end          INTEGER,
  bib_next         INTEGER,                          -- เลขถัดไปที่จะออก
  bib_auto_assign  BOOLEAN NOT NULL DEFAULT true,
  route_map_url    TEXT,
  gpx_url          TEXT,
  water_stations   JSONB NOT NULL DEFAULT '[]',
  sort_order       SMALLINT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, code),
  CHECK (sold + reserved <= capacity),
  CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min),
  CHECK (bib_end IS NULL OR bib_start IS NULL OR bib_end >= bib_start)
);
CREATE INDEX idx_races_event ON races(event_id);

-- ช่วงราคา (Early bird / ปกติ / Late)
CREATE TABLE price_tiers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id       UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  price_satang  BIGINT NOT NULL CHECK (price_satang >= 0),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  quota         INTEGER CHECK (quota >= 0),        -- NULL = ไม่จำกัดใน tier
  sold          INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  nationality_scope TEXT NOT NULL DEFAULT 'all' CHECK (nationality_scope IN ('all', 'thai', 'foreign')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (quota IS NULL OR sold <= quota)
);
CREATE INDEX idx_price_tiers_race_time ON price_tiers(race_id, starts_at, ends_at);

-- รุ่นอายุ
CREATE TABLE age_groups (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id   UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  code      TEXT NOT NULL,                  -- เช่น M30-39
  gender    gender,
  age_min   SMALLINT NOT NULL CHECK (age_min >= 0),
  age_max   SMALLINT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  UNIQUE (race_id, code),
  CHECK (age_max >= age_min)
);

CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  product_type    product_type NOT NULL,
  name_th         TEXT NOT NULL,
  name_en         TEXT,
  description     TEXT,
  image_url       TEXT,
  price_satang    BIGINT NOT NULL DEFAULT 0 CHECK (price_satang >= 0),
  is_required     BOOLEAN NOT NULL DEFAULT false,   -- เช่น เสื้อที่มากับค่าสมัคร
  included_in_race BOOLEAN NOT NULL DEFAULT false,  -- รวมในค่าสมัคร (ราคา 0)
  per_registration BOOLEAN NOT NULL DEFAULT true,   -- ต่อผู้วิ่ง 1 คน หรือ ต่อ order
  max_per_order   SMALLINT CHECK (max_per_order > 0),
  applies_to_race_ids UUID[],                       -- NULL = ทุกระยะ
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      SMALLINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_event ON products(event_id);

-- ตัวเลือกสินค้า เช่น ไซซ์เสื้อ
CREATE TABLE product_variants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           TEXT,
  label         TEXT NOT NULL,                   -- XS, S, M, L ...
  attributes    JSONB NOT NULL DEFAULT '{}',     -- {"chest_in": 38, "length_in": 27}
  price_delta_satang BIGINT NOT NULL DEFAULT 0,
  stock         INTEGER CHECK (stock >= 0),      -- NULL = ไม่จำกัด
  reserved      INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  sold          INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  sort_order    SMALLINT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (product_id, label),
  CHECK (stock IS NULL OR sold + reserved <= stock)
);

-- คำถามเพิ่มเติมที่ผู้จัดกำหนด
CREATE TABLE form_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  label_th      TEXT NOT NULL,
  label_en      TEXT,
  help_text     TEXT,
  question_type question_type NOT NULL,
  options       JSONB,                           -- [{value,label_th,label_en}]
  is_required   BOOLEAN NOT NULL DEFAULT false,
  applies_to_race_ids UUID[],
  validation    JSONB,                           -- {min,max,regex}
  sort_order    SMALLINT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, key),
  CHECK (question_type NOT IN ('select', 'multiselect') OR options IS NOT NULL)
);

CREATE TABLE coupons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID REFERENCES events(id) ON DELETE CASCADE,
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  code              CITEXT NOT NULL,
  description       TEXT,
  discount_type     discount_type NOT NULL,
  discount_value    BIGINT NOT NULL CHECK (discount_value > 0), -- percent: bps / fixed: satang
  max_discount_satang BIGINT CHECK (max_discount_satang > 0),
  min_order_satang  BIGINT NOT NULL DEFAULT 0,
  applies_to_race_ids UUID[],
  usage_limit       INTEGER CHECK (usage_limit > 0),
  usage_per_user    INTEGER CHECK (usage_per_user > 0),
  used_count        INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  is_comp           BOOLEAN NOT NULL DEFAULT false,  -- โควต้าสปอนเซอร์/VIP
  bypass_capacity   BOOLEAN NOT NULL DEFAULT false,
  starts_at         TIMESTAMPTZ,
  ends_at           TIMESTAMPTZ,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR organization_id IS NOT NULL),
  CHECK (discount_type <> 'percent' OR discount_value <= 10000),
  CHECK (usage_limit IS NULL OR used_count <= usage_limit)
);
CREATE UNIQUE INDEX uq_coupons_event_code ON coupons(event_id, code) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX uq_coupons_org_code ON coupons(organization_id, code) WHERE event_id IS NULL;

-- =====================================================================
-- CHECKOUT / ORDERS / PAYMENTS
-- =====================================================================
CREATE TABLE checkout_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  status        checkout_status NOT NULL DEFAULT 'active',
  items         JSONB NOT NULL,                  -- สิ่งที่ผู้ใช้เลือก (snapshot)
  coupon_id     UUID REFERENCES coupons(id),
  queue_token   TEXT,                            -- จาก waiting room
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_checkout_sessions_user ON checkout_sessions(user_id, created_at DESC);
CREATE INDEX idx_checkout_sessions_expiring ON checkout_sessions(expires_at) WHERE status = 'active';

-- การจองโควต้าชั่วคราว (ระยะ หรือ variant สินค้า)
CREATE TABLE inventory_holds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_session_id UUID NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  race_id             UUID REFERENCES races(id),
  product_variant_id  UUID REFERENCES product_variants(id),
  price_tier_id       UUID REFERENCES price_tiers(id),
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  status              hold_status NOT NULL DEFAULT 'held',
  expires_at          TIMESTAMPTZ NOT NULL,
  released_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((race_id IS NOT NULL)::int + (product_variant_id IS NOT NULL)::int = 1)
);
CREATE INDEX idx_inventory_holds_session ON inventory_holds(checkout_session_id);
CREATE INDEX idx_inventory_holds_expiring ON inventory_holds(expires_at) WHERE status = 'held';

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no            TEXT NOT NULL UNIQUE,      -- เลขที่อ่านง่าย เช่น RN25-000123
  event_id            UUID NOT NULL REFERENCES events(id),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  buyer_user_id       UUID REFERENCES users(id),
  checkout_session_id UUID REFERENCES checkout_sessions(id),
  status              order_status NOT NULL DEFAULT 'pending_payment',
  currency            CHAR(3) NOT NULL DEFAULT 'THB',
  subtotal_satang     BIGINT NOT NULL CHECK (subtotal_satang >= 0),
  discount_satang     BIGINT NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  fee_satang          BIGINT NOT NULL DEFAULT 0 CHECK (fee_satang >= 0),     -- ค่าธรรมเนียมที่เก็บจากนักวิ่ง
  total_satang        BIGINT NOT NULL CHECK (total_satang >= 0),
  refunded_satang     BIGINT NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  platform_fee_satang BIGINT NOT NULL DEFAULT 0,                             -- ส่วนแบ่งแพลตฟอร์ม
  gateway_fee_satang  BIGINT NOT NULL DEFAULT 0,
  coupon_id           UUID REFERENCES coupons(id),
  buyer_name          TEXT,
  buyer_email         CITEXT,
  buyer_phone         TEXT,
  billing_info        JSONB,                     -- สำหรับใบกำกับภาษี
  shipping_address    JSONB,
  idempotency_key     TEXT,
  expires_at          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  settlement_id       UUID,                      -- FK เพิ่มด้านล่าง
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (buyer_user_id, idempotency_key),
  CHECK (total_satang = subtotal_satang - discount_satang + fee_satang),
  CHECK (refunded_satang <= total_satang),
  CHECK (status <> 'pending_payment' OR expires_at IS NOT NULL)
);
CREATE INDEX idx_orders_event_status ON orders(event_id, status, created_at DESC);
CREATE INDEX idx_orders_buyer ON orders(buyer_user_id, created_at DESC);
CREATE INDEX idx_orders_pending_expiry ON orders(expires_at) WHERE status = 'pending_payment';
CREATE INDEX idx_orders_buyer_email ON orders(buyer_email);
CREATE INDEX idx_orders_unsettled ON orders(organization_id, paid_at) WHERE status = 'paid' AND settlement_id IS NULL;

CREATE TABLE order_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_type          order_item_type NOT NULL,
  race_id            UUID REFERENCES races(id),
  price_tier_id      UUID REFERENCES price_tiers(id),
  product_variant_id UUID REFERENCES product_variants(id),
  registration_id    UUID,                       -- FK เพิ่มด้านล่าง (add-on ผูกกับผู้วิ่ง)
  description        TEXT NOT NULL,
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_satang  BIGINT NOT NULL CHECK (unit_price_satang >= 0),
  discount_satang    BIGINT NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  total_satang       BIGINT NOT NULL CHECK (total_satang >= 0),
  refunded_satang    BIGINT NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  CHECK (total_satang = unit_price_satang * quantity - discount_satang),
  CHECK (item_type <> 'race' OR race_id IS NOT NULL),
  CHECK (item_type <> 'product' OR product_variant_id IS NOT NULL)
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_variant ON order_items(product_variant_id) WHERE product_variant_id IS NOT NULL;

CREATE TABLE coupon_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id       UUID NOT NULL REFERENCES coupons(id),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  discount_satang BIGINT NOT NULL CHECK (discount_satang >= 0),
  voided_at       TIMESTAMPTZ,                  -- order หมดอายุ/ยกเลิก
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, order_id)
);
CREATE INDEX idx_coupon_redemptions_user ON coupon_redemptions(coupon_id, user_id) WHERE voided_at IS NULL;

CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id),
  gateway            TEXT NOT NULL,              -- omise, 2c2p, gbprimepay, stripe, manual
  method             payment_method NOT NULL,
  status             payment_status NOT NULL DEFAULT 'pending',
  amount_satang      BIGINT NOT NULL CHECK (amount_satang >= 0),
  gateway_fee_satang BIGINT NOT NULL DEFAULT 0,
  gateway_charge_id  TEXT,
  gateway_payload    JSONB,
  qr_payload         TEXT,                       -- PromptPay QR string
  qr_image_url       TEXT,
  authorize_uri      TEXT,                       -- 3DS / mobile banking redirect
  idempotency_key    TEXT NOT NULL UNIQUE,
  failure_code       TEXT,
  failure_message    TEXT,
  expires_at         TIMESTAMPTZ,
  succeeded_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_charge_id)
);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_status ON payments(status, created_at) WHERE status IN ('pending', 'authorized');
-- ป้องกันจ่ายสำเร็จซ้ำใน order เดียว
CREATE UNIQUE INDEX uq_payments_one_success ON payments(order_id) WHERE status = 'succeeded';

-- =====================================================================
-- TEAMS / REGISTRATIONS
-- =====================================================================
CREATE TABLE teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  race_id         UUID REFERENCES races(id),
  name            TEXT NOT NULL,
  captain_user_id UUID REFERENCES users(id),
  join_code       TEXT NOT NULL,
  max_members     SMALLINT CHECK (max_members > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, name),
  UNIQUE (event_id, join_code)
);

CREATE TABLE registrations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_no    TEXT NOT NULL UNIQUE,
  event_id           UUID NOT NULL REFERENCES events(id),
  race_id            UUID NOT NULL REFERENCES races(id),
  order_id           UUID REFERENCES orders(id),
  order_item_id      UUID REFERENCES order_items(id),
  runner_user_id     UUID REFERENCES users(id),        -- บัญชีเจ้าของสิทธิ์ (อาจไม่ใช่คนจ่าย)
  runner_profile_id  UUID REFERENCES runner_profiles(id) ON DELETE SET NULL,
  team_id            UUID REFERENCES teams(id) ON DELETE SET NULL,
  age_group_id       UUID REFERENCES age_groups(id),
  status             registration_status NOT NULL DEFAULT 'pending',
  source             registration_source NOT NULL DEFAULT 'online',
  -- snapshot ข้อมูลผู้วิ่ง ณ วันที่สมัคร (ใช้ทำประกัน/ผลแข่ง)
  runner_snapshot    JSONB NOT NULL,
  first_name_en      TEXT NOT NULL,
  last_name_en       TEXT NOT NULL,
  first_name_th      TEXT,
  last_name_th       TEXT,
  gender             gender NOT NULL,
  birth_date         DATE NOT NULL,
  age_on_race_day    SMALLINT NOT NULL,
  nationality        CHAR(2) NOT NULL,
  id_doc_hash        TEXT NOT NULL,
  email              CITEXT,
  phone              TEXT,
  shirt_variant_id   UUID REFERENCES product_variants(id),
  shirt_size         TEXT,
  answers            JSONB NOT NULL DEFAULT '{}',      -- คำตอบ form_questions
  bib_number         TEXT,
  bib_assigned_at    TIMESTAMPTZ,
  qr_token           TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  price_paid_satang  BIGINT NOT NULL DEFAULT 0 CHECK (price_paid_satang >= 0),
  kit_picked_up_at   TIMESTAMPTZ,
  shipped_at         TIMESTAMPTZ,
  shipping_tracking  TEXT,
  transferred_from_id UUID REFERENCES registrations(id),
  confirmed_at       TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  cancel_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
-- หนึ่งคน (บัตร/พาสปอร์ต) สมัครได้ 1 สิทธิ์ต่อระยะ (ไม่นับที่ยกเลิก/โอนออก)
CREATE UNIQUE INDEX uq_registrations_person_race ON registrations(race_id, id_doc_hash)
  WHERE status IN ('pending', 'confirmed');
-- เลขบิบไม่ซ้ำภายในงาน
CREATE UNIQUE INDEX uq_registrations_event_bib ON registrations(event_id, bib_number)
  WHERE bib_number IS NOT NULL;
CREATE INDEX idx_registrations_event_status ON registrations(event_id, status);
CREATE INDEX idx_registrations_race_status ON registrations(race_id, status);
CREATE INDEX idx_registrations_order ON registrations(order_id);
CREATE INDEX idx_registrations_runner_user ON registrations(runner_user_id, created_at DESC);
CREATE INDEX idx_registrations_name_trgm ON registrations
  USING gin ((first_name_en || ' ' || last_name_en) gin_trgm_ops);
CREATE INDEX idx_registrations_name_th_trgm ON registrations
  USING gin ((coalesce(first_name_th, '') || ' ' || coalesce(last_name_th, '')) gin_trgm_ops);
CREATE INDEX idx_registrations_not_picked ON registrations(event_id) WHERE status = 'confirmed' AND kit_picked_up_at IS NULL;
CREATE INDEX idx_registrations_team ON registrations(team_id) WHERE team_id IS NOT NULL;

ALTER TABLE order_items
  ADD CONSTRAINT fk_order_items_registration
  FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE SET NULL;

CREATE TABLE team_members (
  team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  registration_id UUID NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  is_captain      BOOLEAN NOT NULL DEFAULT false,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, registration_id),
  UNIQUE (registration_id)
);

CREATE TABLE refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES orders(id),
  payment_id        UUID REFERENCES payments(id),
  registration_id   UUID REFERENCES registrations(id),
  status            refund_status NOT NULL DEFAULT 'requested',
  amount_satang     BIGINT NOT NULL CHECK (amount_satang > 0),
  reason            TEXT,
  requested_by      UUID REFERENCES users(id),
  approved_by       UUID REFERENCES users(id),
  gateway_refund_id TEXT,
  gateway_payload   JSONB,
  -- โอนคืนเอง (PromptPay ไม่รองรับ refund ผ่าน gateway บางเจ้า)
  manual_bank_info_enc BYTEA,
  release_inventory BOOLEAN NOT NULL DEFAULT true,
  organizer_note    TEXT,                       -- เหตุผลที่ปฏิเสธ
  transfer_reference TEXT,                      -- เลขอ้างอิงการโอนคืน
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway_refund_id)
);
CREATE INDEX idx_refunds_order ON refunds(order_id);
CREATE INDEX idx_refunds_open ON refunds(created_at) WHERE status IN ('requested', 'approved', 'processing');
CREATE UNIQUE INDEX uq_refunds_open_registration ON refunds(registration_id)
  WHERE registration_id IS NOT NULL AND status IN ('requested', 'approved', 'processing');

-- โอนสิทธิ์ให้คนอื่น
CREATE TABLE transfers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_registration_id  UUID NOT NULL REFERENCES registrations(id),
  to_registration_id    UUID REFERENCES registrations(id),
  from_user_id          UUID NOT NULL REFERENCES users(id),
  to_email              CITEXT NOT NULL,
  to_user_id            UUID REFERENCES users(id),
  accept_token_hash     TEXT NOT NULL UNIQUE,
  fee_satang            BIGINT NOT NULL DEFAULT 0 CHECK (fee_satang >= 0),
  fee_order_id          UUID REFERENCES orders(id),
  status                transfer_status NOT NULL DEFAULT 'pending',
  expires_at            TIMESTAMPTZ NOT NULL,
  runner_payload        JSONB,                  -- ข้อมูลผู้รับโอน ระหว่างรอจ่ายค่าธรรมเนียม
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_transfers_open ON transfers(from_registration_id) WHERE status IN ('pending', 'accepted');
CREATE INDEX idx_transfers_to_email ON transfers(to_email) WHERE status IN ('pending', 'accepted');
CREATE INDEX idx_transfers_fee_order ON transfers(fee_order_id) WHERE fee_order_id IS NOT NULL;

-- เปลี่ยนระยะ
CREATE TABLE race_changes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id   UUID NOT NULL REFERENCES registrations(id),
  from_race_id      UUID NOT NULL REFERENCES races(id),
  to_race_id        UUID NOT NULL REFERENCES races(id),
  price_diff_satang BIGINT NOT NULL DEFAULT 0,   -- บวก = ต้องจ่ายเพิ่ม
  fee_satang        BIGINT NOT NULL DEFAULT 0 CHECK (fee_satang >= 0),
  order_id          UUID REFERENCES orders(id),  -- order ส่วนต่าง
  refund_id         UUID REFERENCES refunds(id), -- กรณีได้เงินคืน
  checkout_session_id UUID REFERENCES checkout_sessions(id), -- กันที่ในระยะใหม่ระหว่างรอจ่าย
  status            race_change_status NOT NULL DEFAULT 'pending_payment',
  requested_by      UUID REFERENCES users(id),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_race_id <> to_race_id)
);
CREATE INDEX idx_race_changes_registration ON race_changes(registration_id);
CREATE INDEX idx_race_changes_order ON race_changes(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_race_changes_open ON race_changes(registration_id) WHERE status = 'pending_payment';

CREATE TABLE waitlist_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id           UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id),
  runner_profile_id UUID REFERENCES runner_profiles(id),
  position          INTEGER NOT NULL,
  status            waitlist_status NOT NULL DEFAULT 'waiting',
  offer_token_hash  TEXT UNIQUE,
  offered_at        TIMESTAMPTZ,
  offer_expires_at  TIMESTAMPTZ,
  registration_id   UUID REFERENCES registrations(id),
  checkout_session_id UUID REFERENCES checkout_sessions(id),  -- checkout ที่รับสิทธิ์ไป; NULL = ยังกันที่ไว้ให้
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (race_id, position)
);
CREATE UNIQUE INDEX uq_waitlist_user_race ON waitlist_entries(race_id, user_id) WHERE status IN ('waiting', 'offered');
CREATE INDEX idx_waitlist_queue ON waitlist_entries(race_id, position) WHERE status = 'waiting';

-- =====================================================================
-- ONSITE: CHECK-IN
-- =====================================================================
CREATE TABLE checkin_points (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                -- เช่น "โต๊ะ 1 (บิบ 1-999)"
  checkin_type checkin_type NOT NULL DEFAULT 'kit_pickup',
  race_ids     UUID[],                       -- NULL = ทุกระยะ
  opens_at     TIMESTAMPTZ,
  closes_at    TIMESTAMPTZ,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, name)
);

-- บัญชี staff หน้างาน (login ด้วย PIN ไม่ต้องมี user เต็ม)
CREATE TABLE staff_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  name            TEXT NOT NULL,
  username        CITEXT NOT NULL,
  pin_hash        TEXT NOT NULL,
  checkin_point_id UUID REFERENCES checkin_points(id) ON DELETE SET NULL,
  can_edit_size   BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  valid_until     TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, username)
);

CREATE TABLE checkins (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  UUID NOT NULL REFERENCES registrations(id),
  checkin_point_id UUID REFERENCES checkin_points(id),
  checkin_type     checkin_type NOT NULL DEFAULT 'kit_pickup',
  staff_account_id UUID REFERENCES staff_accounts(id),
  picked_up_by     TEXT,                       -- รับแทน
  proxy_doc_note   TEXT,
  shirt_size_given TEXT,
  client_uuid      UUID NOT NULL UNIQUE,       -- จาก PWA offline (dedupe ตอน sync)
  scanned_at       TIMESTAMPTZ NOT NULL,       -- เวลาบนเครื่อง
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at        TIMESTAMPTZ,
  void_reason      TEXT
);
CREATE UNIQUE INDEX uq_checkins_once ON checkins(registration_id, checkin_type) WHERE voided_at IS NULL;
CREATE INDEX idx_checkins_point_time ON checkins(checkin_point_id, scanned_at DESC);

-- =====================================================================
-- RESULTS / CERTIFICATES / PHOTOS
-- =====================================================================
CREATE TABLE result_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  race_id       UUID REFERENCES races(id),
  source        TEXT NOT NULL,                 -- csv, raceresult_api, championchip ...
  file_url      TEXT,
  row_count     INTEGER,
  error_count   INTEGER NOT NULL DEFAULT 0,
  errors        JSONB,
  imported_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE results (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  race_id            UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  registration_id    UUID REFERENCES registrations(id),  -- NULL ถ้า import แล้วจับคู่ไม่ได้
  import_id          UUID REFERENCES result_imports(id) ON DELETE SET NULL,
  bib_number         TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  gender             gender,
  age_group_code     TEXT,
  status             result_status NOT NULL,
  gun_time_ms        INTEGER CHECK (gun_time_ms > 0),
  chip_time_ms       INTEGER CHECK (chip_time_ms > 0),
  pace_sec_per_km    INTEGER,
  rank_overall       INTEGER,
  rank_gender        INTEGER,
  rank_age_group     INTEGER,
  -- virtual run
  activity_url       TEXT,
  evidence_urls      TEXT[],
  verified_by        UUID REFERENCES users(id),
  verified_at        TIMESTAMPTZ,
  dq_reason          TEXT,
  is_published       BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (race_id, bib_number),
  CHECK (status <> 'FIN' OR chip_time_ms IS NOT NULL OR gun_time_ms IS NOT NULL)
);
CREATE INDEX idx_results_rank_overall ON results(race_id, rank_overall) WHERE status = 'FIN';
CREATE INDEX idx_results_rank_gender ON results(race_id, gender, rank_gender) WHERE status = 'FIN';
CREATE INDEX idx_results_rank_age ON results(race_id, age_group_code, rank_age_group) WHERE status = 'FIN';
CREATE INDEX idx_results_chip_time ON results(race_id, chip_time_ms) WHERE status = 'FIN';
CREATE INDEX idx_results_registration ON results(registration_id);
CREATE INDEX idx_results_name_trgm ON results USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_results_bib_published ON results(bib_number) WHERE is_published;

CREATE TABLE splits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id      UUID NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  checkpoint     TEXT NOT NULL,                -- เช่น 10K, HALF, CP3
  distance_km    NUMERIC(6,2),
  seq            SMALLINT NOT NULL,
  elapsed_ms     INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  time_of_day    TIMESTAMPTZ,
  rank_at_split  INTEGER,
  UNIQUE (result_id, seq),
  UNIQUE (result_id, checkpoint)
);

CREATE TABLE certificate_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  race_id         UUID REFERENCES races(id),   -- NULL = ใช้ทุกระยะ
  name            TEXT NOT NULL,
  background_url  TEXT NOT NULL,
  width_px        INTEGER NOT NULL CHECK (width_px > 0),
  height_px       INTEGER NOT NULL CHECK (height_px > 0),
  fields          JSONB NOT NULL,              -- [{key:"name",x,y,font,size,color,align}]
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id       UUID NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  template_id     UUID NOT NULL REFERENCES certificate_templates(id),
  file_url        TEXT,
  verify_code     TEXT NOT NULL UNIQUE,        -- ตรวจสอบความถูกต้องผ่าน URL
  generated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (result_id, template_id)
);

CREATE TABLE photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photographer    TEXT,
  original_url    TEXT NOT NULL,
  preview_url     TEXT,
  thumbnail_url   TEXT,
  taken_at        TIMESTAMPTZ,
  location_label  TEXT,
  price_satang    BIGINT NOT NULL DEFAULT 0 CHECK (price_satang >= 0),
  face_index_id   TEXT,                        -- id ใน face recognition service
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processed', 'failed')),
  is_public       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_photos_event_time ON photos(event_id, taken_at);

CREATE TABLE photo_bibs (
  photo_id    UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  bib_number  TEXT NOT NULL,
  confidence  REAL CHECK (confidence BETWEEN 0 AND 1),
  source      TEXT NOT NULL DEFAULT 'ocr' CHECK (source IN ('ocr', 'manual', 'face')),
  PRIMARY KEY (photo_id, bib_number)
);
CREATE INDEX idx_photo_bibs_lookup ON photo_bibs(event_id, bib_number);

-- =====================================================================
-- NOTIFICATIONS / BROADCASTS
-- =====================================================================
CREATE TABLE broadcasts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channels        notification_channel[] NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  audience_filter JSONB NOT NULL DEFAULT '{}',   -- {race_ids:[], status:"confirmed", not_picked_up:true}
  status          broadcast_status NOT NULL DEFAULT 'draft',
  scheduled_at    TIMESTAMPTZ,
  recipient_count INTEGER,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(channels) > 0)
);
CREATE INDEX idx_broadcasts_scheduled ON broadcasts(scheduled_at) WHERE status = 'scheduled';

CREATE TABLE notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  registration_id  UUID REFERENCES registrations(id) ON DELETE SET NULL,
  broadcast_id     UUID REFERENCES broadcasts(id) ON DELETE SET NULL,
  channel          notification_channel NOT NULL,
  template_key     TEXT NOT NULL,            -- order_confirmed, bib_assigned, results_published ...
  recipient        TEXT NOT NULL,            -- email / LINE userId / เบอร์
  payload          JSONB NOT NULL DEFAULT '{}',
  status           notification_status NOT NULL DEFAULT 'queued',
  provider_msg_id  TEXT,
  attempts         SMALLINT NOT NULL DEFAULT 0,
  last_error       TEXT,
  dedupe_key       TEXT UNIQUE,              -- กันส่งซ้ำ
  sent_at          TIMESTAMPTZ,
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_queue ON notifications(created_at) WHERE status = 'queued';
CREATE INDEX idx_notifications_broadcast ON notifications(broadcast_id) WHERE broadcast_id IS NOT NULL;

-- =====================================================================
-- PDPA CONSENTS
-- =====================================================================
CREATE TABLE consents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  runner_profile_id UUID REFERENCES runner_profiles(id) ON DELETE CASCADE,
  registration_id  UUID REFERENCES registrations(id) ON DELETE CASCADE,
  organization_id  UUID REFERENCES organizations(id),
  purpose          consent_purpose NOT NULL,
  policy_version   TEXT NOT NULL,
  granted          BOOLEAN NOT NULL,
  ip               INET,
  user_agent       TEXT,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at     TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR runner_profile_id IS NOT NULL OR registration_id IS NOT NULL)
);
CREATE INDEX idx_consents_user_purpose ON consents(user_id, purpose, granted_at DESC);
CREATE INDEX idx_consents_registration ON consents(registration_id);

CREATE TABLE data_subject_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  request_type  TEXT NOT NULL CHECK (request_type IN ('access', 'export', 'rectify', 'delete', 'object')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'rejected')),
  details       TEXT,
  handled_by    UUID REFERENCES users(id),
  due_at        TIMESTAMPTZ NOT NULL,          -- PDPA: ภายใน 30 วัน
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- FINANCE: TAX INVOICES / SETTLEMENTS / PAYOUTS
-- =====================================================================
CREATE TABLE tax_invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no       TEXT NOT NULL UNIQUE,
  order_id         UUID NOT NULL REFERENCES orders(id),
  issuer_org_id    UUID REFERENCES organizations(id),   -- NULL = แพลตฟอร์มเป็นผู้ออก
  status           tax_invoice_status NOT NULL DEFAULT 'issued',
  buyer_name       TEXT NOT NULL,
  buyer_tax_id     TEXT,
  buyer_branch     TEXT,                                -- สำนักงานใหญ่ / สาขาที่
  buyer_address    TEXT NOT NULL,
  subtotal_satang  BIGINT NOT NULL CHECK (subtotal_satang >= 0),
  vat_satang       BIGINT NOT NULL DEFAULT 0 CHECK (vat_satang >= 0),
  total_satang     BIGINT NOT NULL CHECK (total_satang >= 0),
  pdf_url          TEXT,
  etax_ref         TEXT,                                -- e-Tax Invoice reference
  replaces_id      UUID REFERENCES tax_invoices(id),
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at     TIMESTAMPTZ,
  CHECK (total_satang = subtotal_satang + vat_satang),
  CHECK (buyer_tax_id IS NULL OR buyer_tax_id ~ '^[0-9]{13}$')
);
CREATE INDEX idx_tax_invoices_order ON tax_invoices(order_id);

-- สรุปยอดต่อรอบ ต่อผู้จัด (ต่องาน)
CREATE TABLE settlements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  event_id            UUID REFERENCES events(id),
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  status              settlement_status NOT NULL DEFAULT 'open',
  order_count         INTEGER NOT NULL DEFAULT 0,
  gross_satang        BIGINT NOT NULL DEFAULT 0,
  refunds_satang      BIGINT NOT NULL DEFAULT 0,
  platform_fee_satang BIGINT NOT NULL DEFAULT 0,
  gateway_fee_satang  BIGINT NOT NULL DEFAULT 0,
  withholding_tax_satang BIGINT NOT NULL DEFAULT 0,
  adjustments_satang  BIGINT NOT NULL DEFAULT 0,
  net_satang          BIGINT NOT NULL DEFAULT 0,
  approved_by         UUID REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (net_satang = gross_satang - refunds_satang - platform_fee_satang
                      - gateway_fee_satang - withholding_tax_satang + adjustments_satang)
);
CREATE INDEX idx_settlements_org ON settlements(organization_id, period_end DESC);
CREATE INDEX idx_settlements_event ON settlements(event_id, created_at DESC);

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_settlement
  FOREIGN KEY (settlement_id) REFERENCES settlements(id);

CREATE TABLE payouts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id    UUID NOT NULL REFERENCES settlements(id),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  bank_account_id  UUID NOT NULL REFERENCES bank_accounts(id),
  amount_satang    BIGINT NOT NULL CHECK (amount_satang > 0),
  status           payout_status NOT NULL DEFAULT 'pending',
  transfer_ref     TEXT,
  slip_url         TEXT,
  failure_reason   TEXT,
  paid_at          TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payouts_org ON payouts(organization_id, created_at DESC);
CREATE UNIQUE INDEX uq_payouts_settlement_active ON payouts(settlement_id) WHERE status <> 'failed';

-- =====================================================================
-- CMS
-- =====================================================================
CREATE TABLE cms_pages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          CITEXT NOT NULL UNIQUE,
  title_th      TEXT NOT NULL,
  title_en      TEXT,
  body_th       TEXT,
  body_en       TEXT,
  page_type     TEXT NOT NULL DEFAULT 'page' CHECK (page_type IN ('page', 'article', 'faq', 'policy')),
  seo           JSONB NOT NULL DEFAULT '{}',
  status        cms_status NOT NULL DEFAULT 'draft',
  published_at  TIMESTAMPTZ,
  author_id     UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cms_banners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement    TEXT NOT NULL,                -- home_hero, home_mid, search_top
  image_url    TEXT NOT NULL,
  mobile_image_url TEXT,
  link_url     TEXT,
  event_id     UUID REFERENCES events(id) ON DELETE SET NULL,
  alt_text     TEXT,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  status       cms_status NOT NULL DEFAULT 'draft',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_cms_banners_active ON cms_banners(placement, sort_order) WHERE status = 'published';

-- =====================================================================
-- AUDIT / IDEMPOTENCY / WEBHOOKS
-- =====================================================================
CREATE TABLE audit_logs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type      actor_type NOT NULL,
  actor_id        UUID,
  impersonated_by UUID REFERENCES users(id),
  organization_id UUID REFERENCES organizations(id),
  event_id        UUID REFERENCES events(id),
  action          TEXT NOT NULL,             -- registration.update, refund.approve ...
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  before_data     JSONB,
  after_data      JSONB,
  ip              INET,
  user_agent      TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_org ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);

CREATE TABLE idempotency_keys (
  key             TEXT NOT NULL,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,             -- POST /orders, POST /orders/:id/payments
  request_hash    TEXT NOT NULL,
  response_status SMALLINT,
  response_body   JSONB,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (scope, key)
);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE webhook_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway        TEXT NOT NULL,
  event_id       TEXT NOT NULL,              -- id จาก gateway
  event_type     TEXT NOT NULL,
  signature_ok   BOOLEAN NOT NULL,
  payload        JSONB NOT NULL,
  payment_id     UUID REFERENCES payments(id),
  attempts       SMALLINT NOT NULL DEFAULT 0,
  last_error     TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  UNIQUE (gateway, event_id)
);
CREATE INDEX idx_webhook_events_unprocessed ON webhook_events(received_at) WHERE processed_at IS NULL;

-- =====================================================================
-- VIEWS
-- =====================================================================
-- โควต้าคงเหลือ (ใช้หน้า public)
CREATE VIEW v_race_availability AS
SELECT r.id AS race_id, r.event_id, r.code, r.capacity, r.sold, r.reserved,
       GREATEST(r.capacity - r.sold - r.reserved, 0) AS available,
       (SELECT pt.price_satang FROM price_tiers pt
         WHERE pt.race_id = r.id AND now() >= pt.starts_at AND now() < pt.ends_at
           AND (pt.quota IS NULL OR pt.sold < pt.quota)
         ORDER BY pt.starts_at LIMIT 1) AS current_price_satang
FROM races r
WHERE r.is_active;

-- สรุปเสื้อตามไซซ์ต่องาน (สำหรับสั่งผลิต)
CREATE VIEW v_event_shirt_summary AS
SELECT reg.event_id, reg.race_id, reg.shirt_size, count(*) AS qty
FROM registrations reg
WHERE reg.status = 'confirmed'
GROUP BY reg.event_id, reg.race_id, reg.shirt_size;

-- =====================================================================
-- updated_at triggers
-- =====================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- KEY TRANSACTIONAL SNIPPETS (อ้างอิงสำหรับ application layer)
-- =====================================================================
/*
-- 1) จองโควต้าระยะแบบ atomic (ไม่ oversell) ---------------------------
BEGIN;
UPDATE races
   SET reserved = reserved + $2
 WHERE id = $1 AND is_active
   AND sold + reserved + $2 <= capacity
RETURNING id, capacity - sold - reserved AS remaining;
-- ถ้าไม่มีแถวกลับมา = เต็ม → ROLLBACK แล้วเสนอ waitlist

UPDATE product_variants
   SET reserved = reserved + $4
 WHERE id = $3 AND (stock IS NULL OR sold + reserved + $4 <= stock)
RETURNING id;
-- ถ้าไม่มีแถว = ไซซ์หมด → ROLLBACK

INSERT INTO inventory_holds (checkout_session_id, race_id, price_tier_id, quantity, expires_at)
VALUES ($5, $1, $6, $2, now() + interval '15 minutes');
INSERT INTO inventory_holds (checkout_session_id, product_variant_id, quantity, expires_at)
VALUES ($5, $3, $4, now() + interval '15 minutes');
COMMIT;

-- 2) ยืนยันการชำระเงินจาก webhook (idempotent) -------------------------
BEGIN;
INSERT INTO webhook_events (gateway, event_id, event_type, signature_ok, payload)
VALUES ($gateway, $evt_id, $type, true, $payload)
ON CONFLICT (gateway, event_id) DO NOTHING
RETURNING id;                                   -- ไม่มีแถว = เคยรับแล้ว → COMMIT จบ

UPDATE payments SET status = 'succeeded', succeeded_at = now(), gateway_payload = $payload
 WHERE gateway = $gateway AND gateway_charge_id = $charge_id AND status <> 'succeeded'
RETURNING order_id;

UPDATE orders SET status = 'paid', paid_at = now()
 WHERE id = $order_id AND status IN ('pending_payment', 'expired')
RETURNING checkout_session_id;

-- ย้าย reserved → sold (ถ้า order หมดอายุไปแล้วและ hold ถูกคืน ต้องจองใหม่ ถ้าเต็ม → refund อัตโนมัติ)
UPDATE races r SET reserved = r.reserved - h.quantity, sold = r.sold + h.quantity
  FROM inventory_holds h
 WHERE h.checkout_session_id = $session AND h.status = 'held' AND h.race_id = r.id;
UPDATE product_variants v SET reserved = v.reserved - h.quantity, sold = v.sold + h.quantity
  FROM inventory_holds h
 WHERE h.checkout_session_id = $session AND h.status = 'held' AND h.product_variant_id = v.id;
UPDATE price_tiers pt SET sold = pt.sold + h.quantity
  FROM inventory_holds h
 WHERE h.checkout_session_id = $session AND h.status = 'held' AND h.price_tier_id = pt.id;
UPDATE inventory_holds SET status = 'committed' WHERE checkout_session_id = $session AND status = 'held';
UPDATE checkout_sessions SET status = 'converted' WHERE id = $session;

UPDATE registrations SET status = 'confirmed', confirmed_at = now()
 WHERE order_id = $order_id AND status = 'pending';
UPDATE coupons c SET used_count = used_count + 1
  FROM orders o WHERE o.id = $order_id AND o.coupon_id = c.id;
UPDATE webhook_events SET processed_at = now(), payment_id = $payment_id
 WHERE gateway = $gateway AND event_id = $evt_id;
COMMIT;
-- จากนั้น enqueue: assign bib, ส่ง email/LINE, ออกใบเสร็จ

-- 3) คืนโควต้าที่หมดเวลา (job ทุก 1 นาที) -----------------------------
WITH expired AS (
  UPDATE inventory_holds SET status = 'released', released_at = now()
   WHERE id IN (SELECT id FROM inventory_holds
                 WHERE status = 'held' AND expires_at < now()
                 ORDER BY expires_at
                 LIMIT 500
                 FOR UPDATE SKIP LOCKED)
  RETURNING race_id, product_variant_id, quantity, checkout_session_id
), r AS (
  UPDATE races SET reserved = reserved - x.q
    FROM (SELECT race_id, sum(quantity) q FROM expired WHERE race_id IS NOT NULL GROUP BY race_id) x
   WHERE races.id = x.race_id
), v AS (
  UPDATE product_variants SET reserved = reserved - x.q
    FROM (SELECT product_variant_id, sum(quantity) q FROM expired
           WHERE product_variant_id IS NOT NULL GROUP BY product_variant_id) x
   WHERE product_variants.id = x.product_variant_id
), s AS (
  UPDATE checkout_sessions SET status = 'expired'
   WHERE id IN (SELECT checkout_session_id FROM expired) AND status = 'active'
)
UPDATE orders SET status = 'expired'
 WHERE checkout_session_id IN (SELECT checkout_session_id FROM expired)
   AND status = 'pending_payment';
-- แล้ว: void coupon_redemptions, ยกเลิก registrations ที่ pending, offer waitlist คิวถัดไป

-- 4) ออกเลขบิบถัดไป (ล็อกแถว race กันเลขชน) ---------------------------
WITH next AS (
  UPDATE races
     SET bib_next = COALESCE(bib_next, bib_start) + 1
   WHERE id = $race_id
     AND COALESCE(bib_next, bib_start) <= bib_end
  RETURNING COALESCE(bib_prefix, '') || (bib_next - 1)::text AS bib
)
UPDATE registrations
   SET bib_number = (SELECT bib FROM next), bib_assigned_at = now()
 WHERE id = $registration_id AND bib_number IS NULL
   AND EXISTS (SELECT 1 FROM next)
RETURNING bib_number;
-- ไม่มีแถวกลับมา = ช่วงเลขเต็ม → แจ้งผู้จัดขยาย bib_end
-- เลขที่ถูก reserve ไว้ด้วยมือ (VIP) ให้ข้ามด้วย loop + unique (event_id, bib_number)

-- 5) คำนวณอันดับหลัง import ผล ---------------------------------------
UPDATE results r SET rank_overall = x.ro, rank_gender = x.rg, rank_age_group = x.ra
  FROM (SELECT id,
          rank() OVER (ORDER BY chip_time_ms)                                 AS ro,
          rank() OVER (PARTITION BY gender ORDER BY chip_time_ms)             AS rg,
          rank() OVER (PARTITION BY gender, age_group_code ORDER BY chip_time_ms) AS ra
        FROM results WHERE race_id = $race_id AND status = 'FIN') x
 WHERE r.id = x.id;
*/
