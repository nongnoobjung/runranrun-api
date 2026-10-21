import { Inject, Injectable } from '@nestjs/common';
import { DatabaseError, PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../../config';
import { encryptPii, hashIdDoc, normaliseIdDoc } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { SessionItems } from '../checkout/checkout.service';
import { checkAnswers, loadQuestions } from '../org/org-questions.service';
import { ageOn, computeTotals, CouponRule, PricedLine } from './pricing';

export interface RunnerInput {
  firstNameTh?: string;
  lastNameTh?: string;
  firstNameEn: string;
  lastNameEn: string;
  gender: 'male' | 'female' | 'other';
  birthDate: string;
  nationality: string;
  idDocType: 'thai_id' | 'passport';
  idDocNumber: string;
  email?: string;
  phone?: string;
  bloodType?: 'A' | 'B' | 'AB' | 'O' | 'unknown';
  emergencyName: string;
  emergencyPhone: string;
}

export interface CreateOrderInput {
  checkoutSessionId: string;
  couponCode?: string;
  buyer: { name: string; email: string; phone: string };
  billing?: Record<string, unknown>;
  participants: {
    raceId: string;
    shirtVariantId?: string;
    isSelf?: boolean;
    runner: RunnerInput;
    answers?: Record<string, unknown>;
  }[];
}

const SHIRT_PRODUCT = 'shirt';

@Injectable()
export class OrdersService {
  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, idempotencyKey: string, input: CreateOrderInput) {
    try {
      return await this.dbs.transaction((_tx, client) => this.createInTx(client, userId, idempotencyKey, input));
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_registrations_person_race') {
        throw new ProblemException(409, 'ALREADY_REGISTERED', 'One of the runners is already registered for this race', 'Each ID card or passport can hold one place per race.');
      }
      throw err;
    }
  }

  private async createInTx(client: PoolClient, userId: string, idempotencyKey: string, input: CreateOrderInput) {
    const { rows: sessionRows } = await client.query(
      `SELECT s.id, s.user_id, s.status, s.items, s.expires_at, e.id AS event_id, e.organization_id, e.event_date::text AS event_date
         FROM checkout_sessions s JOIN events e ON e.id = s.event_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [input.checkoutSessionId],
    );
    const session = sessionRows[0];
    if (!session || session.user_id !== userId) throw problems.notFound('Checkout session');
    if (session.status !== 'active' || session.expires_at <= new Date()) {
      throw new ProblemException(409, 'CHECKOUT_EXPIRED', 'Your reserved places have expired. Start again to check availability.');
    }
    const existing = await client.query(
      `SELECT id FROM orders WHERE checkout_session_id = $1 AND status IN ('pending_payment', 'paid')`,
      [session.id],
    );
    if (existing.rowCount) {
      throw new ProblemException(409, 'ORDER_EXISTS', 'An order already exists for this checkout', undefined, { orderId: existing.rows[0].id });
    }

    const items = session.items as SessionItems;
    this.assertParticipantsMatchHolds(items, input.participants);
    const races = await this.loadRaces(client, items.races.map((r) => r.raceId));
    const shirtVariantIds = await this.shirtVariantIds(client, session.event_id);

    const people = input.participants.map((p, index) => {
      const race = races.get(p.raceId)!;
      const age = ageOn(p.runner.birthDate, session.event_date);
      if (race.age_min !== null && age < race.age_min) {
        throw problems.validation(`Runner ${index + 1} must be at least ${race.age_min} on race day for ${race.code}`);
      }
      if (race.age_max !== null && age > race.age_max) {
        throw problems.validation(`Runner ${index + 1} is over the age limit for ${race.code}`);
      }
      if (race.gender_restriction && race.gender_restriction !== p.runner.gender) {
        throw problems.validation(`Runner ${index + 1} cannot enter ${race.code}`);
      }
      if (shirtVariantIds.size > 0 && !p.shirtVariantId) {
        throw problems.validation(`Choose a shirt size for runner ${index + 1}`);
      }
      return { ...p, age, idDocHash: hashIdDoc(p.runner.idDocNumber, this.config.PII_HASH_KEY) };
    });
    const questions = await loadQuestions(client, session.event_id);
    const answerErrors: { path: string; message: string }[] = [];
    const answers = people.map((p, i) => checkAnswers(questions, p.raceId, p.answers, `participants.${i}.answers`, answerErrors));
    if (answerErrors.length) throw problems.validation('Some answers to the registration questions are missing or invalid', answerErrors);
    const seen = new Set<string>();
    for (const p of people) {
      const k = `${p.raceId}:${p.idDocHash}`;
      if (seen.has(k)) throw problems.validation('The same ID card or passport appears twice for one race');
      seen.add(k);
    }

    const coupon = input.couponCode ? await this.loadCoupon(client, session.event_id, userId, input.couponCode) : null;

    const racePrice = new Map(items.races.map((r) => [r.raceId, r]));
    const variantPrice = new Map(items.variants.map((v) => [v.variantId, v]));
    const lines: PricedLine[] = people.map((p, i) => ({
      key: `race:${i}`,
      raceId: p.raceId,
      unitPriceSatang: racePrice.get(p.raceId)!.priceSatang,
      quantity: 1,
    }));
    for (const v of items.variants) {
      lines.push({ key: `variant:${v.variantId}`, unitPriceSatang: v.unitPriceSatang, quantity: v.quantity });
    }
    const totals = computeTotals(lines, coupon?.rule ?? null, this.config.RUNNER_FEE_BPS);

    const seq = await client.query<{ n: string }>(`SELECT nextval('order_no_seq') AS n`);
    const orderNo = `KAO${new Date().getFullYear().toString().slice(2)}-${seq.rows[0].n.padStart(6, '0')}`;
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (order_no, event_id, organization_id, buyer_user_id, checkout_session_id,
                           subtotal_satang, discount_satang, fee_satang, total_satang, coupon_id,
                           buyer_name, buyer_email, buyer_phone, billing_info, idempotency_key, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        orderNo, session.event_id, session.organization_id, userId, session.id,
        totals.subtotalSatang, totals.discountSatang, totals.feeSatang, totals.totalSatang, coupon?.id ?? null,
        input.buyer.name, input.buyer.email, input.buyer.phone, input.billing ? JSON.stringify(input.billing) : null,
        idempotencyKey, session.expires_at,
      ],
    );
    const orderId = order.rows[0].id;

    for (const [i, p] of people.entries()) {
      const race = races.get(p.raceId)!;
      const price = racePrice.get(p.raceId)!;
      const lineDiscount = totals.lineDiscounts.get(`race:${i}`) ?? 0;
      const item = await client.query<{ id: string }>(
        `INSERT INTO order_items (order_id, item_type, race_id, price_tier_id, description, quantity, unit_price_satang, discount_satang, total_satang)
         VALUES ($1, 'race', $2, $3, $4, 1, $5, $6, $7) RETURNING id`,
        [orderId, p.raceId, price.priceTierId, `${race.name_th} · ${price.tierName}`, price.priceSatang, lineDiscount, price.priceSatang - lineDiscount],
      );
      const regNo = await client.query<{ n: string }>(`SELECT nextval('registration_no_seq') AS n`);
      const r = p.runner;
      const snapshot = {
        firstNameTh: r.firstNameTh ?? null, lastNameTh: r.lastNameTh ?? null, firstNameEn: r.firstNameEn, lastNameEn: r.lastNameEn,
        gender: r.gender, birthDate: r.birthDate, nationality: r.nationality, idDocType: r.idDocType,
        idDocLast4: normaliseIdDoc(r.idDocNumber).slice(-4), bloodType: r.bloodType ?? 'unknown',
        emergencyName: r.emergencyName, emergencyPhone: r.emergencyPhone, email: r.email ?? null, phone: r.phone ?? null,
        idDocNumberEnc: encryptPii(normaliseIdDoc(r.idDocNumber), this.config.PII_ENCRYPTION_KEY).toString('base64'),
      };
      const shirt = p.shirtVariantId ? variantPrice.get(p.shirtVariantId) : undefined;
      const ageGroup = await client.query<{ id: string }>(
        `SELECT id FROM age_groups WHERE race_id = $1 AND $2 BETWEEN age_min AND age_max
            AND (gender IS NULL OR gender = $3) ORDER BY sort_order LIMIT 1`,
        [p.raceId, p.age, r.gender],
      );
      const reg = await client.query<{ id: string }>(
        `INSERT INTO registrations (registration_no, event_id, race_id, order_id, order_item_id, runner_user_id, age_group_id,
                                    runner_snapshot, first_name_en, last_name_en, first_name_th, last_name_th, gender,
                                    birth_date, age_on_race_day, nationality, id_doc_hash, email, phone,
                                    shirt_variant_id, shirt_size, answers, price_paid_satang)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
        [
          `R${regNo.rows[0].n}`, session.event_id, p.raceId, orderId, item.rows[0].id, p.isSelf ? userId : null,
          ageGroup.rows[0]?.id ?? null, JSON.stringify(snapshot), r.firstNameEn.toUpperCase(), r.lastNameEn.toUpperCase(),
          r.firstNameTh ?? null, r.lastNameTh ?? null, r.gender, r.birthDate, p.age, r.nationality.toUpperCase(),
          p.idDocHash, r.email ?? null, r.phone ?? null, p.shirtVariantId ?? null, shirt?.label ?? null,
          JSON.stringify(answers[i]), price.priceSatang - lineDiscount,
        ],
      );
      await client.query('UPDATE order_items SET registration_id = $2 WHERE id = $1', [item.rows[0].id, reg.rows[0].id]);
    }

    for (const v of items.variants) {
      await client.query(
        `INSERT INTO order_items (order_id, item_type, product_variant_id, description, quantity, unit_price_satang, total_satang)
         VALUES ($1, 'product', $2, $3, $4, $5, $6)`,
        [orderId, v.variantId, `Size ${v.label}`, v.quantity, v.unitPriceSatang, v.unitPriceSatang * v.quantity],
      );
    }
    if (totals.feeSatang > 0) {
      await client.query(
        `INSERT INTO order_items (order_id, item_type, description, quantity, unit_price_satang, total_satang)
         VALUES ($1, 'fee', 'Payment fee', 1, $2, $2)`,
        [orderId, totals.feeSatang],
      );
    }
    if (coupon) {
      await client.query(
        'INSERT INTO coupon_redemptions (coupon_id, order_id, user_id, discount_satang) VALUES ($1, $2, $3, $4)',
        [coupon.id, orderId, userId, totals.discountSatang],
      );
    }
    return this.view(client, orderId);
  }

  async get(userId: string, orderId: string) {
    const client = await this.dbs.pool.connect();
    try {
      const owner = await client.query('SELECT buyer_user_id FROM orders WHERE id = $1', [orderId]);
      if (!owner.rows[0] || owner.rows[0].buyer_user_id !== userId) throw problems.notFound('Order');
      return await this.view(client, orderId);
    } finally {
      client.release();
    }
  }

  async view(client: PoolClient, orderId: string) {
    const { rows } = await client.query(
      `SELECT o.*, e.slug AS event_slug, e.name_th AS event_name, e.event_date::text AS event_date
         FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1`,
      [orderId],
    );
    const o = rows[0];
    const items = await client.query(
      `SELECT item_type, description, quantity, unit_price_satang, discount_satang, total_satang, registration_id
         FROM order_items WHERE order_id = $1 ORDER BY item_type, description`,
      [orderId],
    );
    const regs = await client.query(
      `SELECT r.id, r.registration_no, r.status, r.first_name_en, r.last_name_en, r.first_name_th, r.last_name_th,
              r.shirt_size, r.bib_number, ra.code AS race_code
         FROM registrations r JOIN races ra ON ra.id = r.race_id WHERE r.order_id = $1 ORDER BY r.registration_no`,
      [orderId],
    );
    const payment = await client.query(
      `SELECT id, method, status, amount_satang, qr_payload, qr_image_url, authorize_uri, expires_at
         FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    return {
      id: o.id,
      orderNo: o.order_no,
      status: o.status,
      event: { id: o.event_id, slug: o.event_slug, name: o.event_name, eventDate: o.event_date },
      subtotalSatang: Number(o.subtotal_satang),
      discountSatang: Number(o.discount_satang),
      feeSatang: Number(o.fee_satang),
      totalSatang: Number(o.total_satang),
      expiresAt: o.expires_at,
      paidAt: o.paid_at,
      items: items.rows.map((i) => ({
        type: i.item_type,
        description: i.description,
        quantity: i.quantity,
        unitPriceSatang: Number(i.unit_price_satang),
        discountSatang: Number(i.discount_satang),
        totalSatang: Number(i.total_satang),
        registrationId: i.registration_id,
      })),
      registrations: regs.rows.map((r) => ({
        id: r.id,
        registrationNo: r.registration_no,
        status: r.status,
        raceCode: r.race_code,
        name: { en: `${r.first_name_en} ${r.last_name_en}`, th: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : null },
        shirtSize: r.shirt_size,
        bibNumber: r.bib_number,
      })),
      payment: payment.rows[0] ? paymentView(payment.rows[0]) : null,
    };
  }

  private assertParticipantsMatchHolds(items: SessionItems, participants: CreateOrderInput['participants']): void {
    const want = new Map(items.races.map((r) => [r.raceId, r.quantity]));
    const got = new Map<string, number>();
    for (const p of participants) got.set(p.raceId, (got.get(p.raceId) ?? 0) + 1);
    const same = want.size === got.size && [...want].every(([k, v]) => got.get(k) === v);
    if (!same) throw problems.validation('Runners must match the places you reserved (same races and counts)');

    const wantShirts = new Map(items.variants.map((v) => [v.variantId, v.quantity]));
    const gotShirts = new Map<string, number>();
    for (const p of participants) if (p.shirtVariantId) gotShirts.set(p.shirtVariantId, (gotShirts.get(p.shirtVariantId) ?? 0) + 1);
    const sameShirts = [...gotShirts].every(([k, v]) => wantShirts.get(k) === v) && [...wantShirts].every(([k, v]) => gotShirts.get(k) === v);
    if (!sameShirts) throw problems.validation('Shirt sizes must match the sizes you reserved');
  }

  private async loadRaces(client: PoolClient, ids: string[]) {
    const { rows } = await client.query(
      'SELECT id, code, name_th, age_min, age_max, gender_restriction FROM races WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return new Map(rows.map((r) => [r.id as string, r]));
  }

  private async shirtVariantIds(client: PoolClient, eventId: string): Promise<Set<string>> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.event_id = $1 AND p.product_type = $2 AND p.is_active AND p.is_required`,
      [eventId, SHIRT_PRODUCT],
    );
    return new Set(rows.map((r) => r.id));
  }

  private async loadCoupon(client: PoolClient, eventId: string, userId: string, code: string): Promise<{ id: string; rule: CouponRule }> {
    const { rows } = await client.query(
      `SELECT * FROM coupons
        WHERE event_id = $1 AND code = $2 AND is_active
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        FOR UPDATE`,
      [eventId, code],
    );
    const c = rows[0];
    if (!c) throw new ProblemException(422, 'COUPON_INVALID', 'This coupon code is not valid for this event');
    const active = await client.query<{ n: string; mine: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE user_id = $2) AS mine
         FROM coupon_redemptions WHERE coupon_id = $1 AND voided_at IS NULL`,
      [c.id, userId],
    );
    if (c.usage_limit !== null && Number(active.rows[0].n) >= c.usage_limit) {
      throw new ProblemException(422, 'COUPON_USED_UP', 'This coupon has been fully used');
    }
    if (c.usage_per_user !== null && Number(active.rows[0].mine) >= c.usage_per_user) {
      throw new ProblemException(422, 'COUPON_ALREADY_USED', 'You have already used this coupon');
    }
    return {
      id: c.id,
      rule: {
        discountType: c.discount_type,
        discountValue: Number(c.discount_value),
        maxDiscountSatang: c.max_discount_satang === null ? null : Number(c.max_discount_satang),
        minOrderSatang: Number(c.min_order_satang),
        appliesToRaceIds: c.applies_to_race_ids,
      },
    };
  }
}

export function paymentView(p: Record<string, any>) {
  return {
    id: p.id,
    method: p.method,
    status: p.status,
    amountSatang: Number(p.amount_satang),
    qrPayload: p.qr_payload,
    qrImageUrl: p.qr_image_url,
    authorizeUri: p.authorize_uri,
    expiresAt: p.expires_at,
  };
}
