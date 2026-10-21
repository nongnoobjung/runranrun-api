/**
 * Typed Drizzle view of the tables the API touches.
 * db/migrations/*.sql is the source of truth; keep these definitions in sync with it.
 */
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => bigint(name, { mode: 'number' });

export const genderEnum = pgEnum('gender', ['male', 'female', 'other']);
export const idDocTypeEnum = pgEnum('id_doc_type', ['thai_id', 'passport']);
export const eventStatusEnum = pgEnum('event_status', ['draft', 'pending_review', 'published', 'closed', 'cancelled']);
export const eventTypeEnum = pgEnum('event_type', ['road', 'trail', 'virtual', 'ultra', 'fun_run']);
export const productTypeEnum = pgEnum('product_type', ['shirt', 'medal', 'shipping', 'insurance', 'photo', 'donation', 'other']);
export const discountTypeEnum = pgEnum('discount_type', ['percent', 'fixed']);
export const checkoutStatusEnum = pgEnum('checkout_status', ['active', 'converted', 'expired', 'abandoned']);
export const holdStatusEnum = pgEnum('hold_status', ['held', 'committed', 'released']);
export const orderStatusEnum = pgEnum('order_status', [
  'pending_payment', 'paid', 'expired', 'cancelled', 'partially_refunded', 'refunded',
]);
export const orderItemTypeEnum = pgEnum('order_item_type', ['race', 'product', 'donation', 'fee', 'transfer_fee', 'change_fee']);
export const paymentMethodEnum = pgEnum('payment_method', ['promptpay', 'card', 'mobile_banking', 'bank_transfer', 'manual', 'free']);
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending', 'authorized', 'succeeded', 'failed', 'expired', 'refunded', 'partially_refunded',
]);
export const registrationStatusEnum = pgEnum('registration_status', ['pending', 'confirmed', 'cancelled', 'transferred', 'refunded']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email'),
  phone: text('phone'),
  displayName: text('display_name'),
  locale: text('locale').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const runnerProfiles = pgTable('runner_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').notNull(),
  isSelf: boolean('is_self').notNull(),
  firstNameTh: text('first_name_th'),
  lastNameTh: text('last_name_th'),
  firstNameEn: text('first_name_en').notNull(),
  lastNameEn: text('last_name_en').notNull(),
  gender: genderEnum('gender').notNull(),
  birthDate: date('birth_date').notNull(),
  nationality: char('nationality', { length: 2 }).notNull(),
  idDocType: idDocTypeEnum('id_doc_type').notNull(),
  idDocNumberEnc: bytea('id_doc_number_enc').notNull(),
  idDocHash: text('id_doc_hash').notNull(),
  idDocLast4: text('id_doc_last4'),
  email: citext('email'),
  phone: text('phone'),
  emergencyName: text('emergency_name'),
  emergencyPhone: text('emergency_phone'),
  shirtSize: text('shirt_size'),
  deletedAt: ts('deleted_at'),
});

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: citext('slug').notNull(),
  nameTh: text('name_th').notNull(),
  nameEn: text('name_en'),
  logoUrl: text('logo_url'),
});

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  slug: citext('slug').notNull(),
  nameTh: text('name_th').notNull(),
  nameEn: text('name_en'),
  summaryTh: text('summary_th'),
  descriptionTh: text('description_th'),
  faq: jsonb('faq').notNull(),
  eventType: eventTypeEnum('event_type').notNull(),
  status: eventStatusEnum('status').notNull(),
  timezone: text('timezone').notNull(),
  eventDate: date('event_date').notNull(),
  provinceCode: text('province_code'),
  venueName: text('venue_name'),
  coverImageUrl: text('cover_image_url'),
  shirtSizeChart: jsonb('shirt_size_chart'),
  registrationOpensAt: ts('registration_opens_at'),
  registrationClosesAt: ts('registration_closes_at'),
  allowTransfer: boolean('allow_transfer').notNull(),
  allowRaceChange: boolean('allow_race_change').notNull(),
  allowRefund: boolean('allow_refund').notNull(),
  waitlistEnabled: boolean('waitlist_enabled').notNull(),
  holdMinutes: smallint('hold_minutes').notNull(),
  isFeatured: boolean('is_featured').notNull(),
});

export const races = pgTable('races', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull(),
  code: text('code').notNull(),
  nameTh: text('name_th').notNull(),
  nameEn: text('name_en'),
  distanceKm: numeric('distance_km').notNull(),
  startAt: ts('start_at'),
  cutoffMinutes: integer('cutoff_minutes'),
  capacity: integer('capacity').notNull(),
  reserved: integer('reserved').notNull(),
  sold: integer('sold').notNull(),
  ageMin: smallint('age_min'),
  ageMax: smallint('age_max'),
  genderRestriction: genderEnum('gender_restriction'),
  bibPrefix: text('bib_prefix'),
  bibStart: integer('bib_start'),
  bibEnd: integer('bib_end'),
  bibNext: integer('bib_next'),
  bibAutoAssign: boolean('bib_auto_assign').notNull(),
  sortOrder: smallint('sort_order').notNull(),
  isActive: boolean('is_active').notNull(),
});

export const priceTiers = pgTable('price_tiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  raceId: uuid('race_id').notNull(),
  name: text('name').notNull(),
  priceSatang: money('price_satang').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  quota: integer('quota'),
  reserved: integer('reserved').notNull(),
  sold: integer('sold').notNull(),
});

export const ageGroups = pgTable('age_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  raceId: uuid('race_id').notNull(),
  code: text('code').notNull(),
  gender: genderEnum('gender'),
  ageMin: smallint('age_min').notNull(),
  ageMax: smallint('age_max').notNull(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull(),
  productType: productTypeEnum('product_type').notNull(),
  nameTh: text('name_th').notNull(),
  priceSatang: money('price_satang').notNull(),
  isRequired: boolean('is_required').notNull(),
  includedInRace: boolean('included_in_race').notNull(),
  perRegistration: boolean('per_registration').notNull(),
  isActive: boolean('is_active').notNull(),
  sortOrder: smallint('sort_order').notNull(),
});

export const productVariants = pgTable('product_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull(),
  label: text('label').notNull(),
  attributes: jsonb('attributes').notNull(),
  priceDeltaSatang: money('price_delta_satang').notNull(),
  stock: integer('stock'),
  reserved: integer('reserved').notNull(),
  sold: integer('sold').notNull(),
  sortOrder: smallint('sort_order').notNull(),
  isActive: boolean('is_active').notNull(),
});

export const coupons = pgTable('coupons', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id'),
  code: citext('code').notNull(),
  discountType: discountTypeEnum('discount_type').notNull(),
  discountValue: money('discount_value').notNull(),
  maxDiscountSatang: money('max_discount_satang'),
  minOrderSatang: money('min_order_satang').notNull(),
  appliesToRaceIds: uuid('applies_to_race_ids').array(),
  usageLimit: integer('usage_limit'),
  usagePerUser: integer('usage_per_user'),
  usedCount: integer('used_count').notNull(),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  isActive: boolean('is_active').notNull(),
});

export const checkoutSessions = pgTable('checkout_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: checkoutStatusEnum('status').notNull(),
  items: jsonb('items').notNull(),
  couponId: uuid('coupon_id'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const inventoryHolds = pgTable('inventory_holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkoutSessionId: uuid('checkout_session_id').notNull(),
  raceId: uuid('race_id'),
  productVariantId: uuid('product_variant_id'),
  priceTierId: uuid('price_tier_id'),
  quantity: integer('quantity').notNull(),
  status: holdStatusEnum('status').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderNo: text('order_no').notNull(),
  eventId: uuid('event_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  buyerUserId: uuid('buyer_user_id'),
  checkoutSessionId: uuid('checkout_session_id'),
  status: orderStatusEnum('status').notNull(),
  subtotalSatang: money('subtotal_satang').notNull(),
  discountSatang: money('discount_satang').notNull(),
  feeSatang: money('fee_satang').notNull(),
  totalSatang: money('total_satang').notNull(),
  couponId: uuid('coupon_id'),
  buyerName: text('buyer_name'),
  buyerEmail: citext('buyer_email'),
  buyerPhone: text('buyer_phone'),
  billingInfo: jsonb('billing_info'),
  idempotencyKey: text('idempotency_key'),
  expiresAt: ts('expires_at'),
  paidAt: ts('paid_at'),
  createdAt: ts('created_at').notNull(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  itemType: orderItemTypeEnum('item_type').notNull(),
  raceId: uuid('race_id'),
  priceTierId: uuid('price_tier_id'),
  productVariantId: uuid('product_variant_id'),
  registrationId: uuid('registration_id'),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceSatang: money('unit_price_satang').notNull(),
  discountSatang: money('discount_satang').notNull(),
  totalSatang: money('total_satang').notNull(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  gateway: text('gateway').notNull(),
  method: paymentMethodEnum('method').notNull(),
  status: paymentStatusEnum('status').notNull(),
  amountSatang: money('amount_satang').notNull(),
  gatewayChargeId: text('gateway_charge_id'),
  gatewayPayload: jsonb('gateway_payload'),
  qrPayload: text('qr_payload'),
  qrImageUrl: text('qr_image_url'),
  authorizeUri: text('authorize_uri'),
  idempotencyKey: text('idempotency_key').notNull(),
  expiresAt: ts('expires_at'),
  succeededAt: ts('succeeded_at'),
  createdAt: ts('created_at').notNull(),
});

export const registrations = pgTable('registrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  registrationNo: text('registration_no').notNull(),
  eventId: uuid('event_id').notNull(),
  raceId: uuid('race_id').notNull(),
  orderId: uuid('order_id'),
  orderItemId: uuid('order_item_id'),
  runnerUserId: uuid('runner_user_id'),
  runnerProfileId: uuid('runner_profile_id'),
  ageGroupId: uuid('age_group_id'),
  status: registrationStatusEnum('status').notNull(),
  runnerSnapshot: jsonb('runner_snapshot').notNull(),
  firstNameEn: text('first_name_en').notNull(),
  lastNameEn: text('last_name_en').notNull(),
  firstNameTh: text('first_name_th'),
  lastNameTh: text('last_name_th'),
  gender: genderEnum('gender').notNull(),
  birthDate: date('birth_date').notNull(),
  ageOnRaceDay: smallint('age_on_race_day').notNull(),
  nationality: char('nationality', { length: 2 }).notNull(),
  idDocHash: text('id_doc_hash').notNull(),
  email: citext('email'),
  phone: text('phone'),
  shirtVariantId: uuid('shirt_variant_id'),
  shirtSize: text('shirt_size'),
  answers: jsonb('answers').notNull(),
  bibNumber: text('bib_number'),
  qrToken: text('qr_token').notNull(),
  pricePaidSatang: money('price_paid_satang').notNull(),
  kitPickedUpAt: ts('kit_picked_up_at'),
  confirmedAt: ts('confirmed_at'),
  createdAt: ts('created_at').notNull(),
});
