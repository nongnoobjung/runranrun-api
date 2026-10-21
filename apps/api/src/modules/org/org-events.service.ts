import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';

const isoDateTime = z.string().datetime({ offset: true });

export const eventFieldsSchema = z.object({
  nameTh: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).nullable(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a-z, 0-9 and dashes only').min(3).max(100),
  eventType: z.enum(['road', 'trail', 'virtual', 'ultra', 'fun_run']),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provinceCode: z.string().trim().max(10).nullable(),
  venueName: z.string().trim().max(200).nullable(),
  venueAddress: z.string().trim().max(500).nullable(),
  summaryTh: z.string().trim().max(300).nullable(),
  descriptionTh: z.string().trim().max(10_000).nullable(),
  coverImageUrl: z.string().url().max(1000).nullable(),
  registrationOpensAt: isoDateTime.nullable(),
  registrationClosesAt: isoDateTime.nullable(),
  holdMinutes: z.number().int().min(5).max(120),
  allowRefund: z.boolean(),
  /** Last moment runners may ask for their money back; null = until race day. */
  refundDeadline: isoDateTime.nullable(),
  /** Share of the registration price paid back, in basis points (8000 = 80%). */
  refundPercentBps: z.number().int().min(0).max(10_000),
  /** Let runners queue for a race once it is full. */
  waitlistEnabled: z.boolean(),
  allowTransfer: z.boolean(),
  /** Paid by the person taking the place over. */
  transferFeeSatang: z.number().int().min(0).max(100_000_00),
  /** Last moment a transfer can be offered or accepted; null = until race day. */
  transferDeadline: isoDateTime.nullable(),
  allowRaceChange: z.boolean(),
  /** Charged on top of any price difference when moving to another race. */
  raceChangeFeeSatang: z.number().int().min(0).max(100_000_00),
  /** Last moment runners may move to another race; null = until race day. */
  raceChangeDeadline: isoDateTime.nullable(),
});
export type EventFields = z.infer<typeof eventFieldsSchema>;

export const createEventSchema = eventFieldsSchema.partial().required({ nameTh: true, eventDate: true });

const EVENT_COLUMNS: Record<keyof EventFields, string> = {
  nameTh: 'name_th',
  nameEn: 'name_en',
  slug: 'slug',
  eventType: 'event_type',
  eventDate: 'event_date',
  provinceCode: 'province_code',
  venueName: 'venue_name',
  venueAddress: 'venue_address',
  summaryTh: 'summary_th',
  descriptionTh: 'description_th',
  coverImageUrl: 'cover_image_url',
  registrationOpensAt: 'registration_opens_at',
  registrationClosesAt: 'registration_closes_at',
  holdMinutes: 'hold_minutes',
  allowRefund: 'allow_refund',
  refundDeadline: 'refund_deadline',
  refundPercentBps: 'refund_percent_bps',
  waitlistEnabled: 'waitlist_enabled',
  allowTransfer: 'allow_transfer',
  transferFeeSatang: 'transfer_fee_satang',
  transferDeadline: 'transfer_deadline',
  allowRaceChange: 'allow_race_change',
  raceChangeFeeSatang: 'race_change_fee_satang',
  raceChangeDeadline: 'race_change_deadline',
};

export const raceFieldsSchema = z.object({
  code: z.string().trim().min(1).max(20),
  nameTh: z.string().trim().min(1).max(100),
  distanceKm: z.number().positive().max(1000),
  capacity: z.number().int().min(0).max(1_000_000),
  startAt: isoDateTime.nullable(),
  cutoffMinutes: z.number().int().positive().max(10_000).nullable(),
  ageMin: z.number().int().min(0).max(100).nullable(),
  bibPrefix: z.string().trim().max(5).nullable(),
  bibStart: z.number().int().min(0).max(999_999).nullable(),
  bibEnd: z.number().int().min(0).max(999_999).nullable(),
});
export type RaceFields = z.infer<typeof raceFieldsSchema>;

const RACE_COLUMNS: Record<keyof RaceFields, string> = {
  code: 'code',
  nameTh: 'name_th',
  distanceKm: 'distance_km',
  capacity: 'capacity',
  startAt: 'start_at',
  cutoffMinutes: 'cutoff_minutes',
  ageMin: 'age_min',
  bibPrefix: 'bib_prefix',
  bibStart: 'bib_start',
  bibEnd: 'bib_end',
};

export const tierFieldsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceSatang: z.number().int().min(0).max(100_000_000),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  quota: z.number().int().min(0).nullable(),
});
export type TierFields = z.infer<typeof tierFieldsSchema>;

export const shirtsSchema = z.object({
  nameTh: z.string().trim().min(1).max(100).default('เสื้อวิ่ง'),
  sizes: z
    .array(z.object({ label: z.string().trim().min(1).max(10), chestIn: z.number().positive().max(100).nullable(), stock: z.number().int().min(0).nullable() }))
    .min(1)
    .max(15)
    .refine((s) => new Set(s.map((x) => x.label.toUpperCase())).size === s.length, 'Each size label must be unique'),
});

type Readiness = { key: 'basics' | 'registration_window' | 'races' | 'prices' | 'organization'; ok: boolean }[];

/** Fixed 10-year bands per gender; organisers rarely change them and results need them from day one. */
const AGE_BANDS: [number, number][] = [[0, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 120]];

const pgCode = (err: unknown) => (err as { code?: string }).code;

@Injectable()
export class OrgEventsService {
  constructor(private readonly dbs: DbService) {}

  async list(orgId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT e.id, e.slug, e.name_th, e.status, e.event_type, e.event_date::text AS event_date, e.cover_image_url,
              e.registration_opens_at, e.registration_closes_at,
              COALESCE((SELECT sum(capacity) FROM races WHERE event_id = e.id AND is_active), 0)::int AS capacity,
              COALESCE((SELECT sum(sold) FROM races WHERE event_id = e.id AND is_active), 0)::int AS sold,
              COALESCE((SELECT sum(total_satang - refunded_satang) FROM orders
                         WHERE event_id = e.id AND status IN ('paid', 'partially_refunded')), 0)::bigint AS revenue
         FROM events e
        WHERE e.organization_id = $1
        ORDER BY (e.status IN ('draft', 'pending_review', 'published')) DESC, e.event_date`,
      [orgId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id, slug: r.slug, nameTh: r.name_th, status: r.status, eventType: r.event_type, eventDate: r.event_date,
        coverImageUrl: r.cover_image_url, registrationOpensAt: r.registration_opens_at, registrationClosesAt: r.registration_closes_at,
        capacity: r.capacity, sold: r.sold, revenueSatang: Number(r.revenue),
      })),
    };
  }

  async create(userId: string, orgId: string, input: z.infer<typeof createEventSchema>) {
    const slug = input.slug ?? slugify(input.nameEn ?? '') ?? `event-${randomBytes(3).toString('hex')}`;
    const fields: Partial<EventFields> = { ...input, slug };
    const cols = Object.keys(fields) as (keyof EventFields)[];
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO events (organization_id, created_by, status, ${cols.map((c) => EVENT_COLUMNS[c]).join(', ')})
           VALUES ($1, $2, 'draft', ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
          [orgId, userId, ...cols.map((c) => fields[c])],
        );
        await writeAudit(client, { actorId: userId, organizationId: orgId, eventId: rows[0].id, action: 'event.create', entityType: 'event', entityId: rows[0].id, after: fields });
        return this.get(orgId, rows[0].id, client);
      });
    } catch (err) {
      throw translate(err);
    }
  }

  async get(orgId: string, eventId: string, client: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const { rows } = await client.query(
      `SELECT e.*, e.event_date::text AS event_date_text, o.status AS org_status
         FROM events e JOIN organizations o ON o.id = e.organization_id
        WHERE e.id = $1 AND e.organization_id = $2`,
      [eventId, orgId],
    );
    const e = rows[0];
    if (!e) throw problems.notFound('Event');
    const races = await client.query(
      `SELECT r.*, COALESCE(json_agg(json_build_object(
                'id', t.id, 'name', t.name, 'priceSatang', t.price_satang, 'startsAt', t.starts_at, 'endsAt', t.ends_at,
                'quota', t.quota, 'sold', t.sold, 'reserved', t.reserved
              ) ORDER BY t.starts_at, t.price_satang) FILTER (WHERE t.id IS NOT NULL), '[]') AS tiers
         FROM races r LEFT JOIN price_tiers t ON t.race_id = r.id
        WHERE r.event_id = $1 AND r.is_active
        GROUP BY r.id ORDER BY r.sort_order, r.distance_km DESC`,
      [eventId],
    );
    const shirt = await this.loadShirt(client, eventId);

    const raceViews = races.rows.map((r) => ({
      id: r.id, code: r.code, nameTh: r.name_th, distanceKm: Number(r.distance_km), capacity: r.capacity, sold: r.sold,
      reserved: r.reserved, startAt: r.start_at, cutoffMinutes: r.cutoff_minutes, ageMin: r.age_min, bibPrefix: r.bib_prefix,
      bibStart: r.bib_start, bibEnd: r.bib_end, bibNext: r.bib_next,
      tiers: (r.tiers as Record<string, unknown>[]).map((t) => ({ ...t, priceSatang: Number(t.priceSatang) })),
    }));
    const readiness: Readiness = [
      { key: 'basics', ok: Boolean(e.name_th && e.event_date && e.venue_name && e.province_code) },
      { key: 'registration_window', ok: Boolean(e.registration_opens_at && e.registration_closes_at) },
      { key: 'races', ok: raceViews.length > 0 },
      { key: 'prices', ok: raceViews.length > 0 && raceViews.every((r) => r.tiers.length > 0) },
      { key: 'organization', ok: e.org_status === 'active' },
    ];
    return {
      id: e.id, slug: e.slug, status: e.status, nameTh: e.name_th, nameEn: e.name_en, eventType: e.event_type,
      eventDate: e.event_date_text, provinceCode: e.province_code, venueName: e.venue_name, venueAddress: e.venue_address,
      summaryTh: e.summary_th, descriptionTh: e.description_th, coverImageUrl: e.cover_image_url,
      registrationOpensAt: e.registration_opens_at, registrationClosesAt: e.registration_closes_at, holdMinutes: e.hold_minutes,
      allowRefund: e.allow_refund, refundDeadline: e.refund_deadline, refundPercentBps: e.refund_percent_bps, waitlistEnabled: e.waitlist_enabled,
      allowTransfer: e.allow_transfer, transferFeeSatang: Number(e.transfer_fee_satang), transferDeadline: e.transfer_deadline,
      allowRaceChange: e.allow_race_change, raceChangeFeeSatang: Number(e.race_change_fee_satang), raceChangeDeadline: e.race_change_deadline,
      publishedAt: e.published_at, races: raceViews, shirt, readiness,
      review: { submittedAt: e.submitted_at, reviewedAt: e.reviewed_at, note: e.review_note },
    };
  }

  async update(userId: string, orgId: string, eventId: string, patch: Partial<EventFields>) {
    const cols = Object.keys(patch) as (keyof EventFields)[];
    if (cols.length === 0) return this.get(orgId, eventId);
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const before = await client.query('SELECT status, slug FROM events WHERE id = $1 FOR UPDATE', [eventId]);
        // A published event's link is already out there (shared posts, QR posters), so its slug stays.
        if (patch.slug && patch.slug !== before.rows[0].slug && before.rows[0].status !== 'draft') {
          throw new ProblemException(409, 'SLUG_LOCKED', 'The event link cannot change after the event is published');
        }
        await client.query(
          `UPDATE events SET ${cols.map((c, i) => `${EVENT_COLUMNS[c]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
          [eventId, ...cols.map((c) => patch[c])],
        );
        await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'event.update', entityType: 'event', entityId: eventId, after: patch });
        return this.get(orgId, eventId, client);
      });
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Opens registration. There is no admin review step yet, so an organisation whose KYC is approved
   * ('active') may publish straight away once the event has everything a runner needs to register.
   */
  async publish(userId: string, orgId: string, eventId: string) {
    const event = await this.get(orgId, eventId);
    const missing = event.readiness.filter((r) => !r.ok).map((r) => r.key);
    if (missing.length) throw new ProblemException(409, 'EVENT_NOT_READY', 'Fill in the missing parts before opening registration', undefined, { missing });
    // An organisation under review sends its event to the platform the first time; after approval it opens and closes on its own.
    const review = await this.dbs.pool.query<{ review_events: boolean; reviewed_at: Date | null }>(
      'SELECT o.review_events, e.reviewed_at FROM events e JOIN organizations o ON o.id = e.organization_id WHERE e.id = $1',
      [eventId],
    );
    if (review.rows[0]?.review_events && !review.rows[0].reviewed_at) return this.setStatus(userId, orgId, eventId, ['draft'], 'pending_review');
    return this.setStatus(userId, orgId, eventId, ['draft', 'pending_review', 'closed'], 'published');
  }

  async close(userId: string, orgId: string, eventId: string) {
    return this.setStatus(userId, orgId, eventId, ['published'], 'closed');
  }

  private async setStatus(userId: string, orgId: string, eventId: string, from: string[], to: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rowCount } = await client.query(
        `UPDATE events SET status = $2::event_status,
                published_at = CASE WHEN $2::event_status = 'published' THEN COALESCE(published_at, now()) ELSE published_at END,
                submitted_at = CASE WHEN $2::event_status = 'pending_review' THEN now() ELSE submitted_at END,
                review_note = CASE WHEN $2::event_status = 'pending_review' THEN NULL ELSE review_note END,
                updated_at = now()
          WHERE id = $1 AND status = ANY($3::event_status[])`,
        [eventId, to, from],
      );
      if (!rowCount) throw new ProblemException(409, 'INVALID_STATUS', `The event cannot move to ${to} from its current status`);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: `event.${to}`, entityType: 'event', entityId: eventId });
      return this.get(orgId, eventId, client);
    });
  }

  async createRace(userId: string, orgId: string, eventId: string, input: RaceFields) {
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        await client.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [eventId]);
        await assertBibRangeFree(client, eventId, null, input);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO races (event_id, ${Object.values(RACE_COLUMNS).join(', ')}, sort_order)
           VALUES ($1, ${Object.keys(RACE_COLUMNS).map((_, i) => `$${i + 2}`).join(', ')},
                   (SELECT COALESCE(max(sort_order) + 1, 0) FROM races WHERE event_id = $1))
           RETURNING id`,
          [eventId, ...(Object.keys(RACE_COLUMNS) as (keyof RaceFields)[]).map((k) => input[k])],
        );
        const raceId = rows[0].id;
        for (const [gender, prefix] of [['male', 'M'], ['female', 'F']] as const) {
          for (const [i, [lo, hi]] of AGE_BANDS.entries()) {
            const code = lo === 0 ? `${prefix}<${hi + 1}` : hi >= 120 ? `${prefix}${lo}+` : `${prefix}${lo}-${hi}`;
            await client.query(
              'INSERT INTO age_groups (race_id, code, gender, age_min, age_max, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
              [raceId, code, gender, lo, hi, i],
            );
          }
        }
        await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'race.create', entityType: 'race', entityId: raceId, after: input });
        return this.get(orgId, eventId, client);
      });
    } catch (err) {
      throw translate(err);
    }
  }

  async updateRace(userId: string, orgId: string, eventId: string, raceId: string, patch: Partial<RaceFields>) {
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query('SELECT * FROM races WHERE id = $1 AND event_id = $2 AND is_active FOR UPDATE', [raceId, eventId]);
        const race = rows[0];
        if (!race) throw problems.notFound('Race');
        if (patch.capacity !== undefined && patch.capacity < race.sold + race.reserved) {
          throw new ProblemException(409, 'CAPACITY_BELOW_SOLD', `Capacity cannot go below the ${race.sold + race.reserved} places already sold or held`);
        }
        if (patch.bibStart !== undefined && patch.bibStart !== race.bib_start && race.bib_next !== null) {
          throw new ProblemException(409, 'BIBS_ISSUED', 'Bib numbers have already been issued from this range; only its end can change');
        }
        await assertBibRangeFree(client, eventId, raceId, {
          bibPrefix: patch.bibPrefix !== undefined ? patch.bibPrefix : race.bib_prefix,
          bibStart: patch.bibStart !== undefined ? patch.bibStart : race.bib_start,
          bibEnd: patch.bibEnd !== undefined ? patch.bibEnd : race.bib_end,
        });
        const cols = Object.keys(patch) as (keyof RaceFields)[];
        if (cols.length) {
          await client.query(
            `UPDATE races SET ${cols.map((c, i) => `${RACE_COLUMNS[c]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
            [raceId, ...cols.map((c) => patch[c])],
          );
        }
        await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'race.update', entityType: 'race', entityId: raceId, after: patch });
        return this.get(orgId, eventId, client);
      });
    } catch (err) {
      throw translate(err);
    }
  }

  /** Removes a race nobody has bought. Once anything references it, it is hidden instead so history stays intact. */
  async deleteRace(userId: string, orgId: string, eventId: string, raceId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query('SELECT sold, reserved FROM races WHERE id = $1 AND event_id = $2 AND is_active FOR UPDATE', [raceId, eventId]);
      if (!rows[0]) throw problems.notFound('Race');
      if (rows[0].sold + rows[0].reserved > 0) throw new ProblemException(409, 'RACE_HAS_REGISTRATIONS', 'This race already has runners');
      await client.query('SAVEPOINT remove_race');
      try {
        await client.query('DELETE FROM races WHERE id = $1', [raceId]);
      } catch (err) {
        if (pgCode(err) !== '23503') throw err;
        await client.query('ROLLBACK TO SAVEPOINT remove_race');
        await client.query('UPDATE races SET is_active = false, updated_at = now() WHERE id = $1', [raceId]);
      }
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'race.delete', entityType: 'race', entityId: raceId });
      return this.get(orgId, eventId, client);
    });
  }

  async createTier(userId: string, orgId: string, eventId: string, raceId: string, input: TierFields) {
    assertTierWindow(input.startsAt, input.endsAt);
    return this.dbs.transaction(async (_tx, client) => {
      await this.lockRace(client, eventId, raceId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO price_tiers (race_id, name, price_satang, starts_at, ends_at, quota) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [raceId, input.name, input.priceSatang, input.startsAt, input.endsAt, input.quota],
      );
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'price_tier.create', entityType: 'price_tier', entityId: rows[0].id, after: input });
      return this.get(orgId, eventId, client);
    });
  }

  async updateTier(userId: string, orgId: string, eventId: string, raceId: string, tierId: string, patch: Partial<TierFields>) {
    return this.dbs.transaction(async (_tx, client) => {
      await this.lockRace(client, eventId, raceId);
      const { rows } = await client.query('SELECT * FROM price_tiers WHERE id = $1 AND race_id = $2 FOR UPDATE', [tierId, raceId]);
      const tier = rows[0];
      if (!tier) throw problems.notFound('Price tier');
      const next = {
        name: patch.name ?? tier.name,
        priceSatang: patch.priceSatang ?? Number(tier.price_satang),
        startsAt: patch.startsAt ?? tier.starts_at,
        endsAt: patch.endsAt ?? tier.ends_at,
        quota: patch.quota !== undefined ? patch.quota : tier.quota,
      };
      assertTierWindow(next.startsAt, next.endsAt);
      if (next.quota !== null && next.quota < tier.sold + tier.reserved) {
        throw new ProblemException(409, 'QUOTA_BELOW_SOLD', `The quota cannot go below the ${tier.sold + tier.reserved} places already sold or held at this price`);
      }
      await client.query(
        `UPDATE price_tiers SET name = $2, price_satang = $3, starts_at = $4, ends_at = $5, quota = $6, updated_at = now() WHERE id = $1`,
        [tierId, next.name, next.priceSatang, next.startsAt, next.endsAt, next.quota],
      );
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'price_tier.update', entityType: 'price_tier', entityId: tierId, after: patch });
      return this.get(orgId, eventId, client);
    });
  }

  async deleteTier(userId: string, orgId: string, eventId: string, raceId: string, tierId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      await this.lockRace(client, eventId, raceId);
      const { rows } = await client.query('SELECT sold, reserved FROM price_tiers WHERE id = $1 AND race_id = $2 FOR UPDATE', [tierId, raceId]);
      if (!rows[0]) throw problems.notFound('Price tier');
      if (rows[0].sold + rows[0].reserved > 0) {
        throw new ProblemException(409, 'TIER_HAS_SALES', 'Places were sold at this price; end it early instead of deleting it');
      }
      await client.query('DELETE FROM price_tiers WHERE id = $1', [tierId]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'price_tier.delete', entityType: 'price_tier', entityId: tierId });
      return this.get(orgId, eventId, client);
    });
  }

  /**
   * Replaces the size list of the event's shirt. Sizes are matched by label; a size left out is hidden
   * rather than deleted because orders and registrations point at it.
   */
  async setShirts(userId: string, orgId: string, eventId: string, input: z.infer<typeof shirtsSchema>) {
    return this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      let productId = (
        await client.query<{ id: string }>(
          `SELECT id FROM products WHERE event_id = $1 AND product_type = 'shirt' AND is_required ORDER BY created_at LIMIT 1`,
          [eventId],
        )
      ).rows[0]?.id;
      if (productId) {
        await client.query('UPDATE products SET name_th = $2, is_active = true, updated_at = now() WHERE id = $1', [productId, input.nameTh]);
      } else {
        productId = (
          await client.query<{ id: string }>(
            `INSERT INTO products (event_id, product_type, name_th, price_satang, is_required, included_in_race)
             VALUES ($1, 'shirt', $2, 0, true, true) RETURNING id`,
            [eventId, input.nameTh],
          )
        ).rows[0].id;
      }
      const existing = await client.query<{ id: string; label: string; sold: number; reserved: number }>(
        'SELECT id, label, sold, reserved FROM product_variants WHERE product_id = $1 FOR UPDATE',
        [productId],
      );
      const byLabel = new Map(existing.rows.map((v) => [v.label.toUpperCase(), v]));
      for (const [i, size] of input.sizes.entries()) {
        const label = size.label.toUpperCase();
        const current = byLabel.get(label);
        if (current && size.stock !== null && size.stock < current.sold + current.reserved) {
          throw new ProblemException(409, 'STOCK_BELOW_SOLD', `Size ${label} already has ${current.sold + current.reserved} shirts sold or held`, undefined, { label });
        }
        await client.query(
          `INSERT INTO product_variants (product_id, label, attributes, stock, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, true)
           ON CONFLICT (product_id, label) DO UPDATE
             SET attributes = EXCLUDED.attributes, stock = EXCLUDED.stock, sort_order = EXCLUDED.sort_order, is_active = true`,
          [productId, label, JSON.stringify(size.chestIn === null ? {} : { chest_in: size.chestIn }), size.stock, i],
        );
      }
      const kept = input.sizes.map((s) => s.label.toUpperCase());
      await client.query('UPDATE product_variants SET is_active = false WHERE product_id = $1 AND NOT (upper(label) = ANY($2))', [productId, kept]);
      await client.query('UPDATE events SET shirt_size_chart = $2, updated_at = now() WHERE id = $1', [
        eventId,
        JSON.stringify(input.sizes.map((s) => ({ size: s.label.toUpperCase(), chestIn: s.chestIn }))),
      ]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'shirts.update', entityType: 'product', entityId: productId, after: input });
      return this.get(orgId, eventId, client);
    });
  }

  async dashboard(eventId: string) {
    const pool = this.dbs.pool;
    const [kpis, daily, races, recent, event] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'confirmed' AND kit_picked_up_at IS NOT NULL)::int AS picked_up,
                count(*) FILTER (WHERE status = 'confirmed' AND confirmed_at >= now() - interval '1 day')::int AS last_24h,
                (SELECT COALESCE(sum(total_satang - refunded_satang), 0) FROM orders
                  WHERE event_id = $1 AND status IN ('paid', 'partially_refunded'))::bigint AS revenue
           FROM registrations WHERE event_id = $1`,
        [eventId],
      ),
      pool.query(
        `SELECT d::date::text AS day, count(r.id)::int AS count
           FROM generate_series((now() AT TIME ZONE 'Asia/Bangkok')::date - 13, (now() AT TIME ZONE 'Asia/Bangkok')::date, interval '1 day') d
           LEFT JOIN registrations r
             ON r.event_id = $1 AND r.status = 'confirmed' AND (r.confirmed_at AT TIME ZONE 'Asia/Bangkok')::date = d::date
          GROUP BY d ORDER BY d`,
        [eventId],
      ),
      pool.query(
        `SELECT r.id, r.code, r.distance_km, r.capacity, r.sold, r.reserved, a.current_price_satang
           FROM races r LEFT JOIN v_race_availability a ON a.race_id = r.id
          WHERE r.event_id = $1 AND r.is_active ORDER BY r.sort_order, r.distance_km DESC`,
        [eventId],
      ),
      pool.query(
        `SELECT r.id, r.first_name_th, r.last_name_th, r.first_name_en, r.last_name_en, ra.code AS race_code, r.confirmed_at
           FROM registrations r JOIN races ra ON ra.id = r.race_id
          WHERE r.event_id = $1 AND r.status = 'confirmed'
          ORDER BY r.confirmed_at DESC LIMIT 8`,
        [eventId],
      ),
      pool.query(`SELECT name_th, status, event_date::text AS event_date, slug FROM events WHERE id = $1`, [eventId]),
    ]);
    const k = kpis.rows[0];
    return {
      event: { nameTh: event.rows[0].name_th, status: event.rows[0].status, eventDate: event.rows[0].event_date, slug: event.rows[0].slug },
      kpis: {
        confirmed: k.confirmed,
        pendingPayment: k.pending,
        pickedUp: k.picked_up,
        last24h: k.last_24h,
        revenueSatang: Number(k.revenue),
        capacity: races.rows.reduce((n, r) => n + r.capacity, 0),
      },
      daily: daily.rows,
      races: races.rows.map((r) => ({
        id: r.id, code: r.code, distanceKm: Number(r.distance_km), capacity: r.capacity, sold: r.sold, reserved: r.reserved,
        currentPriceSatang: r.current_price_satang === null ? null : Number(r.current_price_satang),
      })),
      shirts: (await this.loadShirt(pool, eventId))?.sizes ?? [],
      recent: recent.rows.map((r) => ({
        id: r.id,
        name: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : `${r.first_name_en} ${r.last_name_en}`,
        raceCode: r.race_code,
        confirmedAt: r.confirmed_at,
      })),
    };
  }

  private async loadShirt(client: Pick<PoolClient, 'query'>, eventId: string) {
    const { rows } = await client.query(
      `SELECT p.id, p.name_th, COALESCE(json_agg(json_build_object(
                'id', v.id, 'label', v.label, 'chestIn', (v.attributes->>'chest_in')::numeric, 'stock', v.stock,
                'sold', v.sold, 'reserved', v.reserved
              ) ORDER BY v.sort_order) FILTER (WHERE v.id IS NOT NULL AND v.is_active), '[]') AS sizes
         FROM products p LEFT JOIN product_variants v ON v.product_id = p.id
        WHERE p.event_id = $1 AND p.product_type = 'shirt' AND p.is_required AND p.is_active
        GROUP BY p.id ORDER BY p.created_at LIMIT 1`,
      [eventId],
    );
    return rows[0] ? { productId: rows[0].id as string, nameTh: rows[0].name_th as string, sizes: rows[0].sizes as ShirtSize[] } : null;
  }

  private async lockRace(client: PoolClient, eventId: string, raceId: string) {
    const { rowCount } = await client.query('SELECT 1 FROM races WHERE id = $1 AND event_id = $2 AND is_active FOR UPDATE', [raceId, eventId]);
    if (!rowCount) throw problems.notFound('Race');
  }
}

interface ShirtSize {
  id: string;
  label: string;
  chestIn: number | null;
  stock: number | null;
  sold: number;
  reserved: number;
}

function slugify(value: string): string | null {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return slug.length >= 3 ? `${slug}-${randomBytes(2).toString('hex')}` : null;
}

function assertTierWindow(startsAt: string | Date, endsAt: string | Date) {
  if (new Date(endsAt) <= new Date(startsAt)) throw problems.validation('The price must end after it starts');
}

/** Bib numbers are unique per event, so two races sharing a prefix must not have overlapping ranges. */
async function assertBibRangeFree(
  client: PoolClient,
  eventId: string,
  raceId: string | null,
  range: Pick<RaceFields, 'bibPrefix' | 'bibStart' | 'bibEnd'>,
) {
  if (range.bibStart === null) return;
  if (range.bibEnd !== null && range.bibEnd < range.bibStart) throw problems.validation('The last bib number must not be lower than the first');
  const { rows } = await client.query<{ code: string }>(
    `SELECT code FROM races
      WHERE event_id = $1 AND is_active AND ($2::uuid IS NULL OR id <> $2) AND bib_start IS NOT NULL
        AND COALESCE(bib_prefix, '') = COALESCE($3, '')
        AND int4range(bib_start, COALESCE(bib_end, 2147483646), '[]') && int4range($4, COALESCE($5, 2147483646), '[]')`,
    [eventId, raceId, range.bibPrefix, range.bibStart, range.bibEnd],
  );
  if (rows[0]) {
    throw new ProblemException(409, 'BIB_RANGE_OVERLAP', `This bib range overlaps the ${rows[0].code} race`, undefined, { race: rows[0].code });
  }
}

/** Maps the database's own guards to problems the web app can show. */
function translate(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'events_slug_key') return new ProblemException(409, 'SLUG_TAKEN', 'Another event already uses this link');
  if (e.code === '23505' && e.constraint === 'races_event_id_code_key') return new ProblemException(409, 'RACE_CODE_TAKEN', 'This event already has a race with that code');
  if (e.code === '23514' && e.constraint === 'events_check1') return problems.validation('Registration must close after it opens');
  if (e.code === '23514' && e.constraint === 'races_check2') return problems.validation('The last bib number must not be lower than the first');
  return err;
}
