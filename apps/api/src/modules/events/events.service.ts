import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { problems } from '../../common/problem';

export interface EventListQuery {
  q?: string;
  province?: string;
  type?: string;
  month?: string; // YYYY-MM
  limit: number;
  offset: number;
}

type Availability = 'open' | 'almost_full' | 'sold_out' | 'not_open' | 'closed';

export function raceAvailability(
  available: number,
  capacity: number,
  opensAt: Date | null,
  closesAt: Date | null,
  now = new Date(),
): Availability {
  if (opensAt && now < opensAt) return 'not_open';
  if (closesAt && now >= closesAt) return 'closed';
  if (available <= 0) return 'sold_out';
  if (available <= Math.max(1, Math.ceil(capacity * 0.05))) return 'almost_full';
  return 'open';
}

@Injectable()
export class EventsService {
  constructor(private readonly dbs: DbService) {}

  async list(query: EventListQuery) {
    const where: string[] = [`e.status = 'published'`, 'e.event_date >= current_date'];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (query.q) add('(e.name_th ILIKE ? OR e.name_en ILIKE ? OR e.venue_name ILIKE ?)', `%${query.q}%`);
    if (query.province) add('e.province_code = ?', query.province);
    if (query.type) add('e.event_type = ?', query.type);
    if (query.month) add(`to_char(e.event_date, 'YYYY-MM') = ?`, query.month);
    params.push(query.limit, query.offset);

    const { rows } = await this.dbs.pool.query(
      `SELECT e.id, e.slug, e.name_th, e.name_en, e.event_type, e.event_date, e.province_code, e.venue_name,
              e.cover_image_url, e.registration_opens_at, e.registration_closes_at,
              COALESCE(json_agg(json_build_object(
                'code', a.code, 'distanceKm', r.distance_km, 'capacity', a.capacity,
                'available', a.available, 'priceSatang', a.current_price_satang
              ) ORDER BY r.sort_order, r.distance_km) FILTER (WHERE r.id IS NOT NULL), '[]') AS races,
              count(*) OVER () AS total
         FROM events e
         LEFT JOIN races r ON r.event_id = e.id AND r.is_active
         LEFT JOIN v_race_availability a ON a.race_id = r.id
        WHERE ${where.join(' AND ')}
        GROUP BY e.id
        ORDER BY e.event_date, e.name_th
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      total: rows.length ? Number(rows[0].total) : 0,
      items: rows.map((e) => {
        const races = e.races as { code: string; distanceKm: string; capacity: number; available: number; priceSatang: string | null }[];
        const prices = races.map((r) => r.priceSatang).filter((p): p is string => p !== null).map(Number);
        const capacity = races.reduce((s, r) => s + r.capacity, 0);
        const available = races.reduce((s, r) => s + r.available, 0);
        return {
          id: e.id,
          slug: e.slug,
          name: { th: e.name_th, en: e.name_en },
          type: e.event_type,
          eventDate: e.event_date,
          province: e.province_code,
          venue: e.venue_name,
          coverImageUrl: e.cover_image_url,
          races: races.map((r) => ({ code: r.code, distanceKm: Number(r.distanceKm) })),
          fromPriceSatang: prices.length ? Math.min(...prices) : null,
          availability: raceAvailability(available, capacity, e.registration_opens_at, e.registration_closes_at),
        };
      }),
    };
  }

  async getBySlug(slug: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT e.*, o.slug AS org_slug, o.name_th AS org_name, o.logo_url AS org_logo
         FROM events e JOIN organizations o ON o.id = e.organization_id
        WHERE e.slug = $1 AND e.status IN ('published', 'closed')`,
      [slug],
    );
    const e = rows[0];
    if (!e) throw problems.notFound('Event');

    const races = await this.racesWithAvailability(e.id, e.registration_opens_at, e.registration_closes_at);
    const products = await this.dbs.pool.query(
      `SELECT p.id, p.product_type, p.name_th, p.price_satang, p.is_required, p.included_in_race, p.per_registration,
              COALESCE(json_agg(json_build_object(
                'id', v.id, 'label', v.label, 'attributes', v.attributes,
                'priceDeltaSatang', v.price_delta_satang,
                'available', CASE WHEN v.stock IS NULL THEN NULL ELSE GREATEST(v.stock - v.sold - v.reserved, 0) END
              ) ORDER BY v.sort_order) FILTER (WHERE v.id IS NOT NULL AND v.is_active), '[]') AS variants
         FROM products p LEFT JOIN product_variants v ON v.product_id = p.id
        WHERE p.event_id = $1 AND p.is_active
        GROUP BY p.id ORDER BY p.sort_order`,
      [e.id],
    );

    return {
      id: e.id,
      slug: e.slug,
      name: { th: e.name_th, en: e.name_en },
      summary: e.summary_th,
      description: e.description_th,
      type: e.event_type,
      status: e.status,
      eventDate: e.event_date,
      timezone: e.timezone,
      province: e.province_code,
      venue: e.venue_name,
      coverImageUrl: e.cover_image_url,
      faq: e.faq,
      shirtSizeChart: e.shirt_size_chart,
      registration: { opensAt: e.registration_opens_at, closesAt: e.registration_closes_at, holdMinutes: e.hold_minutes },
      policy: { allowTransfer: e.allow_transfer, allowRaceChange: e.allow_race_change, allowRefund: e.allow_refund, waitlist: e.waitlist_enabled },
      organizer: { slug: e.org_slug, name: e.org_name, logoUrl: e.org_logo },
      races,
      products: products.rows.map((p) => ({
        id: p.id,
        type: p.product_type,
        name: p.name_th,
        priceSatang: Number(p.price_satang),
        required: p.is_required,
        includedInRace: p.included_in_race,
        perRegistration: p.per_registration,
        variants: (p.variants as { priceDeltaSatang: string }[]).map((v) => ({ ...v, priceDeltaSatang: Number(v.priceDeltaSatang) })),
      })),
    };
  }

  async availability(slug: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT id, registration_opens_at, registration_closes_at FROM events
        WHERE slug = $1 AND status IN ('published', 'closed')`,
      [slug],
    );
    if (!rows[0]) throw problems.notFound('Event');
    return { races: await this.racesWithAvailability(rows[0].id, rows[0].registration_opens_at, rows[0].registration_closes_at) };
  }

  private async racesWithAvailability(eventId: string, opensAt: Date | null, closesAt: Date | null) {
    const { rows } = await this.dbs.pool.query(
      `SELECT r.id, r.code, r.name_th, r.distance_km, r.start_at, r.cutoff_minutes, r.age_min, r.age_max,
              r.gender_restriction, a.capacity, a.available, a.current_price_satang,
              (SELECT pt.name FROM price_tiers pt
                WHERE pt.race_id = r.id AND now() >= pt.starts_at AND now() < pt.ends_at
                  AND (pt.quota IS NULL OR pt.sold + pt.reserved < pt.quota)
                ORDER BY pt.starts_at LIMIT 1) AS tier_name
         FROM races r JOIN v_race_availability a ON a.race_id = r.id
        WHERE r.event_id = $1
        ORDER BY r.sort_order, r.distance_km DESC`,
      [eventId],
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name_th,
      distanceKm: Number(r.distance_km),
      startAt: r.start_at,
      cutoffMinutes: r.cutoff_minutes,
      ageMin: r.age_min,
      ageMax: r.age_max,
      genderRestriction: r.gender_restriction,
      capacity: r.capacity,
      available: r.available,
      priceSatang: r.current_price_satang === null ? null : Number(r.current_price_satang),
      tierName: r.tier_name,
      availability: raceAvailability(r.available, r.capacity, opensAt, closesAt),
    }));
  }
}
