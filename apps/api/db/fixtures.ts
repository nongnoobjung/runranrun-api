import { Pool } from 'pg';

export interface RaceFixture {
  code: string;
  nameTh: string;
  distanceKm: number;
  capacity: number;
  ageMin?: number;
  bibStart?: number;
  bibEnd?: number;
  tiers: { name: string; priceSatang: number; quota?: number; startsAt?: Date; endsAt?: Date }[];
}

export interface EventFixture {
  slug: string;
  nameTh: string;
  nameEn?: string;
  eventDate: string;
  provinceCode?: string;
  venueName?: string;
  opensAt?: Date;
  closesAt?: Date;
  holdMinutes?: number;
  races: RaceFixture[];
  shirtSizes?: { label: string; chestIn: number; stock: number }[];
  coupons?: { code: string; type: 'percent' | 'fixed'; value: number; usageLimit?: number; usagePerUser?: number }[];
}

export interface CreatedEvent {
  eventId: string;
  organizationId: string;
  raceIds: Record<string, string>;
  variantIds: Record<string, string>;
}

const DAY = 86_400_000;

/** Inserts an organisation and a published event with races, tiers, age groups, shirts and coupons. */
export async function createEvent(pool: Pool, f: EventFixture, orgSlug = 'riverside-sports'): Promise<CreatedEvent> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (slug, name_th, name_en, status, contact_email, review_events)
       VALUES ($1, 'Riverside Sports', 'Riverside Sports', 'active', 'hello@riverside.example', false)
       ON CONFLICT (slug) DO UPDATE SET name_th = EXCLUDED.name_th
       RETURNING id`,
      [orgSlug],
    );
    const organizationId = org.rows[0].id;
    const now = Date.now();
    const ev = await client.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name_th, name_en, summary_th, event_type, status, event_date,
                           province_code, venue_name, registration_opens_at, registration_closes_at, hold_minutes,
                           allow_transfer, allow_refund, refund_percent_bps, waitlist_enabled, published_at,
                           faq, shirt_size_chart)
       VALUES ($1,$2,$3,$4,$5,'road','published',$6,$7,$8,$9,$10,$11,true,true,8000,true,now(),$12,$13)
       RETURNING id`,
      [
        organizationId, f.slug, f.nameTh, f.nameEn ?? null, 'วิ่งเลียบเจ้าพระยาตอนกลางคืน ปิดถนนตลอดสาย',
        f.eventDate, f.provinceCode ?? 'BKK', f.venueName ?? 'ลานริมน้ำ บางคอแหลม',
        f.opensAt ?? new Date(now - DAY), f.closesAt ?? new Date(now + 90 * DAY), f.holdMinutes ?? 15,
        JSON.stringify([{ qTh: 'สมัครให้เพื่อนได้ไหม', aTh: 'ได้ สูงสุด 10 คนต่อคำสั่งซื้อ', qEn: 'Can I register my friends?', aEn: 'Yes, up to 10 runners per order.' }]),
        JSON.stringify((f.shirtSizes ?? []).map((s) => ({ size: s.label, chestIn: s.chestIn }))),
      ],
    );
    const eventId = ev.rows[0].id;

    const raceIds: Record<string, string> = {};
    for (const [i, r] of f.races.entries()) {
      const race = await client.query<{ id: string }>(
        `INSERT INTO races (event_id, code, name_th, distance_km, capacity, age_min, bib_start, bib_end, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [eventId, r.code, r.nameTh, r.distanceKm, r.capacity, r.ageMin ?? null, r.bibStart ?? null, r.bibEnd ?? null, i],
      );
      raceIds[r.code] = race.rows[0].id;
      for (const t of r.tiers) {
        await client.query(
          `INSERT INTO price_tiers (race_id, name, price_satang, quota, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [race.rows[0].id, t.name, t.priceSatang, t.quota ?? null, t.startsAt ?? new Date(now - DAY), t.endsAt ?? new Date(now + 90 * DAY)],
        );
      }
      for (const [gender, prefix] of [['male', 'M'], ['female', 'F']] as const) {
        for (let lo = 10; lo < 80; lo += 10) {
          await client.query(
            `INSERT INTO age_groups (race_id, code, gender, age_min, age_max, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
            [race.rows[0].id, `${prefix}${lo}-${lo + 9}`, gender, lo, lo + 9, lo],
          );
        }
      }
    }

    const variantIds: Record<string, string> = {};
    if (f.shirtSizes?.length) {
      const product = await client.query<{ id: string }>(
        `INSERT INTO products (event_id, product_type, name_th, price_satang, is_required, included_in_race)
         VALUES ($1, 'shirt', 'เสื้อวิ่ง Dry-fit', 0, true, true) RETURNING id`,
        [eventId],
      );
      for (const [i, s] of f.shirtSizes.entries()) {
        const v = await client.query<{ id: string }>(
          `INSERT INTO product_variants (product_id, label, attributes, stock, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [product.rows[0].id, s.label, JSON.stringify({ chest_in: s.chestIn }), s.stock, i],
        );
        variantIds[s.label] = v.rows[0].id;
      }
    }

    for (const c of f.coupons ?? []) {
      await client.query(
        `INSERT INTO coupons (event_id, code, discount_type, discount_value, usage_limit, usage_per_user) VALUES ($1,$2,$3,$4,$5,$6)`,
        [eventId, c.code, c.type, c.value, c.usageLimit ?? null, c.usagePerUser ?? null],
      );
    }
    await client.query('COMMIT');
    return { eventId, organizationId, raceIds, variantIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const RIVERSIDE_NIGHT_RUN: EventFixture = {
  slug: 'riverside-night-run-2027',
  nameTh: 'Riverside Night Run 2027',
  nameEn: 'Riverside Night Run 2027',
  eventDate: '2027-02-14',
  closesAt: new Date('2027-01-31T17:00:00Z'),
  races: [
    {
      code: '21K', nameTh: 'ฮาล์ฟมาราธอน 21.1 กม.', distanceKm: 21.1, capacity: 2000, ageMin: 16, bibStart: 1, bibEnd: 2000,
      tiers: [
        { name: 'Early bird', priceSatang: 120_000, quota: 800, endsAt: new Date('2026-11-30T17:00:00Z') },
        { name: 'ปกติ', priceSatang: 140_000 },
      ],
    },
    {
      code: '10K', nameTh: 'มินิมาราธอน 10 กม.', distanceKm: 10, capacity: 1500, ageMin: 12, bibStart: 2001, bibEnd: 3500,
      tiers: [
        { name: 'Early bird', priceSatang: 90_000, quota: 600, endsAt: new Date('2026-11-30T17:00:00Z') },
        { name: 'ปกติ', priceSatang: 100_000 },
      ],
    },
    {
      code: '5K', nameTh: 'ฟันรัน 5 กม.', distanceKm: 5, capacity: 1000, bibStart: 5001, bibEnd: 6000,
      tiers: [{ name: 'ราคาเดียว', priceSatang: 65_000 }],
    },
  ],
  shirtSizes: [
    { label: 'XS', chestIn: 34, stock: 220 },
    { label: 'S', chestIn: 36, stock: 700 },
    { label: 'M', chestIn: 38, stock: 1450 },
    { label: 'L', chestIn: 40, stock: 1200 },
    { label: 'XL', chestIn: 42, stock: 650 },
    { label: '2XL', chestIn: 44, stock: 242 },
  ],
  coupons: [{ code: 'RUN10', type: 'percent', value: 1000, usageLimit: 500, usagePerUser: 1 }],
};

export const RIVERSIDE_ORGANIZER_EMAIL = 'organizer@riverside.example';

/** Makes the user with this email (created if needed) an accepted member of the organisation. */
export async function addOrgMember(
  pool: Pool,
  organizationId: string,
  email: string,
  role: 'owner' | 'admin' | 'finance' | 'staff' | 'viewer' = 'owner',
): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email, email.split('@')[0]],
  );
  await pool.query(
    `INSERT INTO org_members (organization_id, user_id, role, accepted_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, accepted_at = COALESCE(org_members.accepted_at, now())`,
    [organizationId, user.rows[0].id, role],
  );
  return user.rows[0].id;
}

/** Gives the user with this email (created if needed) a platform role, e.g. to use the admin backoffice. */
export async function setPlatformRole(pool: Pool, email: string, role: 'user' | 'support' | 'finance' | 'admin' | 'superadmin'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, display_name, platform_role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET platform_role = EXCLUDED.platform_role
     RETURNING id`,
    [email, email.split('@')[0], role],
  );
  return rows[0].id;
}
