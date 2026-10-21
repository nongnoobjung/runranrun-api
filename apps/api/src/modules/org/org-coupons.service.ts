import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';

const isoDateTime = z.string().datetime({ offset: true });

export const couponFieldsSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, '3–30 letters, digits, - or _'),
  description: z.string().trim().max(200).nullable(),
  /** percent: basis points (1000 = 10%); fixed: satang. */
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().int().positive(),
  maxDiscountSatang: z.number().int().positive().nullable(),
  usageLimit: z.number().int().positive().nullable(),
  usagePerUser: z.number().int().positive().nullable(),
  startsAt: isoDateTime.nullable(),
  endsAt: isoDateTime.nullable(),
  isActive: z.boolean(),
});
export type CouponFields = z.infer<typeof couponFieldsSchema>;

export const createCouponSchema = couponFieldsSchema
  .partial()
  .required({ code: true, discountType: true, discountValue: true })
  .refine((c) => c.discountType !== 'percent' || c.discountValue <= 10_000, { message: 'A percentage cannot exceed 100%', path: ['discountValue'] });

const COLUMNS: Record<keyof CouponFields, string> = {
  code: 'code',
  description: 'description',
  discountType: 'discount_type',
  discountValue: 'discount_value',
  maxDiscountSatang: 'max_discount_satang',
  usageLimit: 'usage_limit',
  usagePerUser: 'usage_per_user',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  isActive: 'is_active',
};

/** Fields that change what a runner already paid for; locked once the code has been used. */
const PRICE_FIELDS: (keyof CouponFields)[] = ['code', 'discountType', 'discountValue', 'maxDiscountSatang'];

const LIST_SQL = `
  SELECT c.*, (SELECT count(*) FROM coupon_redemptions cr WHERE cr.coupon_id = c.id AND cr.voided_at IS NULL)::int AS used,
         (SELECT COALESCE(sum(cr.discount_satang), 0) FROM coupon_redemptions cr
            JOIN orders o ON o.id = cr.order_id AND o.status IN ('paid', 'partially_refunded')
           WHERE cr.coupon_id = c.id AND cr.voided_at IS NULL)::bigint AS discount_given
    FROM coupons c`;

@Injectable()
export class OrgCouponsService {
  constructor(private readonly dbs: DbService) {}

  async list(eventId: string) {
    const { rows } = await this.dbs.pool.query(`${LIST_SQL} WHERE c.event_id = $1 ORDER BY c.is_active DESC, c.created_at DESC`, [eventId]);
    return { items: rows.map(view) };
  }

  async create(userId: string, orgId: string, eventId: string, input: z.infer<typeof createCouponSchema>) {
    const cols = Object.keys(input) as (keyof CouponFields)[];
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO coupons (event_id, created_by, ${cols.map((c) => COLUMNS[c]).join(', ')})
           VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
          [eventId, userId, ...cols.map((c) => input[c])],
        );
        await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'coupon.create', entityType: 'coupon', entityId: rows[0].id, after: input });
        return view((await client.query(`${LIST_SQL} WHERE c.id = $1`, [rows[0].id])).rows[0]);
      });
    } catch (err) {
      throw translate(err);
    }
  }

  async update(userId: string, orgId: string, eventId: string, couponId: string, patch: Partial<CouponFields>) {
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query(`${LIST_SQL} WHERE c.id = $1 AND c.event_id = $2 FOR UPDATE OF c`, [couponId, eventId]);
        const coupon = rows[0];
        if (!coupon) throw problems.notFound('Coupon');
        if (coupon.used > 0 && PRICE_FIELDS.some((f) => patch[f] !== undefined && String(patch[f]) !== String(coupon[COLUMNS[f]]))) {
          throw new ProblemException(409, 'COUPON_IN_USE', 'Runners have already used this code, so its discount cannot change');
        }
        if (patch.usageLimit != null && patch.usageLimit < coupon.used) {
          throw new ProblemException(409, 'USAGE_BELOW_USED', `The code has already been used ${coupon.used} times`);
        }
        const type = patch.discountType ?? coupon.discount_type;
        const value = patch.discountValue ?? Number(coupon.discount_value);
        if (type === 'percent' && value > 10_000) throw problems.validation('A percentage cannot exceed 100%');
        const cols = Object.keys(patch) as (keyof CouponFields)[];
        if (cols.length) {
          await client.query(
            `UPDATE coupons SET ${cols.map((c, i) => `${COLUMNS[c]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
            [couponId, ...cols.map((c) => patch[c])],
          );
        }
        await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'coupon.update', entityType: 'coupon', entityId: couponId, after: patch });
        return view((await client.query(`${LIST_SQL} WHERE c.id = $1`, [couponId])).rows[0]);
      });
    } catch (err) {
      throw translate(err);
    }
  }
}

function view(c: Record<string, any>) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    discountType: c.discount_type,
    discountValue: Number(c.discount_value),
    maxDiscountSatang: c.max_discount_satang === null ? null : Number(c.max_discount_satang),
    usageLimit: c.usage_limit,
    usagePerUser: c.usage_per_user,
    used: c.used,
    discountGivenSatang: Number(c.discount_given),
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    isActive: c.is_active,
  };
}

function translate(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'uq_coupons_event_code') return new ProblemException(409, 'COUPON_CODE_TAKEN', 'This event already has a coupon with that code');
  return err;
}
