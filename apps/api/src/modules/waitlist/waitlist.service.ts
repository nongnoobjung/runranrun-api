import { Inject, Injectable } from '@nestjs/common';
import { DatabaseError, PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../../config';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { CheckoutService } from '../checkout/checkout.service';
import { queueWaitlistOffers } from '../notifications/emails';

/**
 * A queue per race for when it is full. Freed places are offered to the queue in order: an offer holds one of the
 * race's reserved places for WAITLIST_OFFER_HOURS. Claiming turns that hold into a normal checkout; leaving, or letting
 * the offer run out, passes the place to the next runner.
 */
@Injectable()
export class WaitlistService {
  constructor(
    private readonly dbs: DbService,
    private readonly checkout: CheckoutService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Joins the queue for a full race of an event that has a waitlist and is still taking registrations. */
  async join(userId: string, raceId: string) {
    try {
      const id = await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query(
          `SELECT ra.id, ra.capacity, ra.sold, ra.reserved, e.waitlist_enabled, e.status, e.registration_opens_at, e.registration_closes_at
             FROM races ra JOIN events e ON e.id = ra.event_id
            WHERE ra.id = $1 AND ra.is_active FOR UPDATE OF ra`,
          [raceId],
        );
        const r = rows[0];
        if (!r || !['published', 'closed'].includes(r.status)) throw problems.notFound('Race');
        if (!r.waitlist_enabled) throw new ProblemException(409, 'WAITLIST_DISABLED', 'This event has no waitlist');
        const now = Date.now();
        if (r.status === 'closed' || (r.registration_opens_at && now < r.registration_opens_at.getTime()) || (r.registration_closes_at && now >= r.registration_closes_at.getTime())) {
          throw new ProblemException(409, 'REGISTRATION_CLOSED', 'Registration is not open for this event');
        }
        const queued = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM waitlist_entries WHERE race_id = $1 AND status = 'waiting'`, [raceId]);
        // Open places go to the queue first, so only refuse when nobody is waiting for them.
        if (r.capacity - r.sold - r.reserved > 0 && queued.rows[0].n === 0) {
          throw new ProblemException(409, 'RACE_NOT_FULL', 'This race still has places; register instead');
        }
        const ins = await client.query<{ id: string }>(
          `INSERT INTO waitlist_entries (race_id, user_id, position)
           VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM waitlist_entries WHERE race_id = $1)) RETURNING id`,
          [raceId, userId],
        );
        return ins.rows[0].id;
      });
      return (await this.mine(userId)).items.find((e) => e.id === id)!;
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_waitlist_user_race') {
        throw new ProblemException(409, 'ALREADY_IN_WAITLIST', 'You are already in the queue for this race');
      }
      throw err;
    }
  }

  /** The caller's places in queues, with how many are ahead of them. */
  async mine(userId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT w.*, ra.code AS race_code, ra.distance_km, e.slug AS event_slug, e.name_th AS event_name, e.event_date::text AS event_date,
              (SELECT count(*) FROM waitlist_entries x WHERE x.race_id = w.race_id AND x.status = 'waiting' AND x.position < w.position)::int AS ahead,
              (SELECT a.current_price_satang FROM v_race_availability a WHERE a.race_id = w.race_id) AS price
         FROM waitlist_entries w JOIN races ra ON ra.id = w.race_id JOIN events e ON e.id = ra.event_id
        WHERE w.user_id = $1 AND w.status IN ('waiting', 'offered')
        ORDER BY e.event_date, ra.code`,
      [userId],
    );
    return {
      items: rows.map((w) => ({
        id: w.id,
        status: w.status as 'waiting' | 'offered',
        position: w.position,
        ahead: w.ahead,
        offerExpiresAt: w.offer_expires_at,
        checkoutSessionId: w.checkout_session_id,
        priceSatang: w.price === null ? null : Number(w.price),
        race: { id: w.race_id, code: w.race_code, distanceKm: Number(w.distance_km) },
        event: { slug: w.event_slug, name: w.event_name, eventDate: w.event_date },
        joinedAt: w.created_at,
      })),
    };
  }

  /** Leaves the queue, or turns down an offer so the place goes to the next runner. */
  async leave(userId: string, entryId: string) {
    const raceId = await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT * FROM waitlist_entries WHERE id = $1 AND user_id = $2 AND status IN ('waiting', 'offered') FOR UPDATE`,
        [entryId, userId],
      );
      const w = rows[0];
      if (!w) throw problems.notFound('Waitlist entry');
      await client.query(`UPDATE waitlist_entries SET status = 'cancelled' WHERE id = $1`, [entryId]);
      if (w.status === 'offered' && !w.checkout_session_id) await releaseHold(client, w.race_id);
      return w.race_id as string;
    });
    await this.offerFreed(raceId);
    return { id: entryId, status: 'cancelled' };
  }

  /**
   * Starts checkout for an offered place. The first time, the offer's held place becomes the checkout's hold; if that
   * checkout is still open it is returned again; if it lapsed, a new one is tried while the offer lasts.
   */
  async claim(userId: string, entryId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT w.*, ra.event_id, s.status AS session_status, s.expires_at AS session_expires_at
         FROM waitlist_entries w JOIN races ra ON ra.id = w.race_id LEFT JOIN checkout_sessions s ON s.id = w.checkout_session_id
        WHERE w.id = $1 AND w.user_id = $2`,
      [entryId, userId],
    );
    const w = rows[0];
    if (!w) throw problems.notFound('Waitlist entry');
    if (w.status !== 'offered' || w.offer_expires_at <= new Date()) {
      throw new ProblemException(409, 'NO_OFFER', 'There is no place on offer for you right now');
    }
    if (w.session_status === 'active' && w.session_expires_at > new Date()) return { checkoutSessionId: w.checkout_session_id as string };
    const holding = !w.checkout_session_id;
    const session = await this.checkout.create(
      userId,
      { eventId: w.event_id, races: [{ raceId: w.race_id, quantity: 1 }], variants: [] },
      {
        beforeReserve: async (client, sessionId) => {
          // Lock the entry so a double click cannot release the held place twice.
          const locked = await client.query(
            `UPDATE waitlist_entries SET checkout_session_id = $2 WHERE id = $1 AND status = 'offered' AND checkout_session_id IS NOT DISTINCT FROM $3 RETURNING id`,
            [entryId, sessionId, w.checkout_session_id],
          );
          if (!locked.rowCount) throw new ProblemException(409, 'NO_OFFER', 'There is no place on offer for you right now');
          if (holding) await releaseHold(client, w.race_id);
        },
      },
    );
    return { checkoutSessionId: session.id };
  }

  /**
   * Expires offers that ran out, then offers each queue as many places as its race has free. Runs every 30 seconds and
   * after anything that frees places. Returns how many offers it made.
   */
  async offerFreed(raceId?: string): Promise<number> {
    const hours = this.config.WAITLIST_OFFER_HOURS;
    return this.dbs.transaction(async (_tx, client) => {
      const expired = await client.query<{ race_id: string; held: boolean }>(
        `UPDATE waitlist_entries SET status = 'expired'
          WHERE status = 'offered' AND offer_expires_at <= now() AND ($1::uuid IS NULL OR race_id = $1)
          RETURNING race_id, checkout_session_id IS NULL AS held`,
        [raceId ?? null],
      );
      for (const e of expired.rows) if (e.held) await releaseHold(client, e.race_id);

      const races = await client.query<{ id: string; free: number }>(
        `SELECT ra.id, ra.capacity - ra.sold - ra.reserved AS free
           FROM races ra JOIN events e ON e.id = ra.event_id
          WHERE e.waitlist_enabled AND ($1::uuid IS NULL OR ra.id = $1)
            AND EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.race_id = ra.id AND w.status = 'waiting')
          ORDER BY ra.id FOR UPDATE OF ra`,
        [raceId ?? null],
      );
      let offered = 0;
      for (const r of races.rows) {
        if (r.free <= 0) continue;
        const next = await client.query<{ id: string }>(
          `UPDATE waitlist_entries SET status = 'offered', offered_at = now(), offer_expires_at = now() + make_interval(secs => $3)
            WHERE id IN (SELECT id FROM waitlist_entries WHERE race_id = $1 AND status = 'waiting' ORDER BY position LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING id`,
          [r.id, r.free, Math.round(hours * 3600)],
        );
        if (next.rowCount) await client.query('UPDATE races SET reserved = reserved + $2 WHERE id = $1', [r.id, next.rowCount]);
        await queueWaitlistOffers(client, next.rows.map((n) => n.id));
        offered += next.rowCount ?? 0;
      }
      return offered;
    });
  }

  /** The queues of an event for the organiser: counts per race and everyone still in line. */
  async forEvent(eventId: string) {
    const races = await this.dbs.pool.query(
      `SELECT ra.id, ra.code, ra.capacity, ra.sold, ra.reserved,
              count(w.id) FILTER (WHERE w.status = 'waiting')::int AS waiting,
              count(w.id) FILTER (WHERE w.status = 'offered')::int AS offered,
              count(w.id) FILTER (WHERE w.status = 'converted')::int AS converted,
              count(w.id) FILTER (WHERE w.status = 'expired')::int AS expired
         FROM races ra LEFT JOIN waitlist_entries w ON w.race_id = ra.id
        WHERE ra.event_id = $1 AND ra.is_active GROUP BY ra.id ORDER BY ra.sort_order, ra.distance_km DESC`,
      [eventId],
    );
    const entries = await this.dbs.pool.query(
      `SELECT w.id, w.race_id, w.position, w.status, w.created_at, w.offered_at, w.offer_expires_at, w.checkout_session_id,
              u.display_name, u.email
         FROM waitlist_entries w JOIN races ra ON ra.id = w.race_id JOIN users u ON u.id = w.user_id
        WHERE ra.event_id = $1 AND w.status IN ('waiting', 'offered') ORDER BY w.race_id, w.position`,
      [eventId],
    );
    return {
      races: races.rows.map((r) => ({
        raceId: r.id,
        code: r.code,
        free: Math.max(r.capacity - r.sold - r.reserved, 0),
        counts: { waiting: r.waiting, offered: r.offered, converted: r.converted, expired: r.expired },
        entries: entries.rows
          .filter((e) => e.race_id === r.id)
          .map((e) => ({
            id: e.id,
            position: e.position,
            status: e.status as 'waiting' | 'offered',
            name: e.display_name ?? e.email,
            email: e.email,
            joinedAt: e.created_at,
            offeredAt: e.offered_at,
            offerExpiresAt: e.offer_expires_at,
            claimed: e.checkout_session_id !== null,
          })),
      })),
    };
  }
}

/** Gives back the reserved place an unclaimed offer was holding. */
async function releaseHold(client: PoolClient, raceId: string): Promise<void> {
  await client.query('UPDATE races SET reserved = reserved - 1 WHERE id = $1 AND reserved > 0', [raceId]);
}
