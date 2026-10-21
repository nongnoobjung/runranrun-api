import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { WaitlistService } from '../waitlist/waitlist.service';

/**
 * The version of the terms and privacy policy the web currently shows. Bump it (and the date on the policy pages)
 * whenever the wording changes, so consents record which text a person agreed to.
 */
export const POLICY_VERSION = '2026-10-22';

/** What a buyer agrees to when placing an order. Terms, privacy and sharing with the organiser are conditions of registering. */
export const orderConsentSchema = z.object({
  terms: z.literal(true),
  privacy: z.literal(true),
  /** The runners' details go to the event's organiser, who runs the race. */
  shareWithOrganizer: z.literal(true),
  /** Optional: news about other events from the platform. */
  marketing: z.boolean().optional(),
});
export type OrderConsents = z.infer<typeof orderConsentSchema>;

export const consentChangeSchema = z.object({ purpose: z.literal('marketing'), granted: z.boolean() });
export const deleteAccountSchema = z.object({ confirm: z.literal(true) });

/** Where a consent was given, kept as evidence alongside it. */
export interface ConsentContext {
  ip: string | null;
  userAgent: string | null;
}

type Db = Pick<PoolClient, 'query'>;

/** Records the consents given with an order: one row per purpose, and the organiser share per registration. */
export async function recordOrderConsents(
  db: Db,
  input: { userId: string; organizationId: string; registrationIds: string[]; consents: OrderConsents; context: ConsentContext },
): Promise<void> {
  const { userId, organizationId, consents, context } = input;
  const rows: [string | null, string, boolean][] = [
    [null, 'terms', true],
    [null, 'privacy', true],
    // Per runner when the registrations exist already; otherwise (a transfer still being paid for) once for the account.
    ...(input.registrationIds.length
      ? input.registrationIds.map((id): [string, string, boolean] => [id, 'share_with_organizer', true])
      : [[null, 'share_with_organizer', true] as [null, string, boolean]]),
    ...(consents.marketing === undefined ? [] : [[null, 'marketing', consents.marketing] as [null, string, boolean]]),
  ];
  for (const [registrationId, purpose, granted] of rows) {
    await db.query(
      `INSERT INTO consents (user_id, registration_id, organization_id, purpose, policy_version, granted, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, registrationId, purpose === 'share_with_organizer' ? organizationId : null, purpose, POLICY_VERSION, granted, context.ip, context.userAgent],
    );
  }
}

/**
 * The PDPA rights a runner can use themselves: see and change their consents, download what the platform holds about
 * them, and close their account.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly dbs: DbService,
    private readonly waitlist: WaitlistService,
  ) {}

  /** The current answer for each purpose the account has been asked about, and the full history. */
  async consents(userId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT c.purpose, c.granted, c.policy_version, c.granted_at, c.registration_id, r.registration_no, e.name_th AS event_name
         FROM consents c
         LEFT JOIN registrations r ON r.id = c.registration_id
         LEFT JOIN events e ON e.id = r.event_id
        WHERE c.user_id = $1
        ORDER BY c.granted_at DESC, c.purpose`,
      [userId],
    );
    const latest = (purpose: string) => rows.find((c) => c.purpose === purpose && !c.registration_id);
    const current = (purpose: string) => {
      const c = latest(purpose);
      return c ? { granted: c.granted as boolean, policyVersion: c.policy_version as string, at: c.granted_at as Date } : null;
    };
    return {
      policyVersion: POLICY_VERSION,
      current: { terms: current('terms'), privacy: current('privacy'), marketing: current('marketing') },
      history: rows.map((c) => ({
        purpose: c.purpose as string,
        granted: c.granted as boolean,
        policyVersion: c.policy_version as string,
        at: c.granted_at as Date,
        registration: c.registration_id ? { id: c.registration_id as string, registrationNo: c.registration_no as string, eventName: c.event_name as string } : null,
      })),
    };
  }

  /** Gives or withdraws an optional consent; each change is a new row, so the history stays. */
  async changeConsent(userId: string, input: z.infer<typeof consentChangeSchema>, context: ConsentContext) {
    await this.dbs.pool.query(
      `INSERT INTO consents (user_id, purpose, policy_version, granted, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, input.purpose, POLICY_VERSION, input.granted, context.ip, context.userAgent],
    );
    return this.consents(userId);
  }

  /**
   * Everything the platform holds about the account holder, as JSON they can keep. ID numbers stay masked (the
   * full number is never shown back, even to its owner); payment card details are held by the gateway, not here.
   */
  async export(userId: string) {
    const q = async (sql: string) => (await this.dbs.pool.query(sql, [userId])).rows;
    const [user] = await q(`SELECT email, phone, display_name, locale, created_at, last_login_at FROM users WHERE id = $1`);
    const [profiles, registrations, orders, consents, waitlist, transfers, teams] = await Promise.all([
      q(`SELECT nickname, is_self, first_name_th, last_name_th, first_name_en, last_name_en, gender, birth_date::text AS birth_date, nationality,
                id_doc_type, id_doc_last4, email, phone, blood_type, emergency_name, emergency_phone, emergency_relation, shirt_size, club_name,
                created_at, updated_at
           FROM runner_profiles WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at`),
      q(`SELECT r.registration_no, r.status, e.name_th AS event, e.event_date::text AS event_date, ra.code AS race,
                r.first_name_th, r.last_name_th, r.first_name_en, r.last_name_en, r.gender, r.birth_date::text AS birth_date, r.nationality,
                r.runner_snapshot->>'idDocType' AS id_doc_type, r.runner_snapshot->>'idDocLast4' AS id_doc_last4,
                r.runner_snapshot->>'emergencyName' AS emergency_name, r.runner_snapshot->>'emergencyPhone' AS emergency_phone,
                r.email, r.phone, r.shirt_size, r.answers, r.bib_number, r.kit_picked_up_at, r.created_at
           FROM registrations r JOIN events e ON e.id = r.event_id JOIN races ra ON ra.id = r.race_id
           LEFT JOIN orders o ON o.id = r.order_id
          WHERE r.runner_user_id = $1 OR (o.buyer_user_id = $1 AND r.transferred_from_id IS NULL)
          ORDER BY r.created_at`),
      q(`SELECT order_no, status, total_satang, buyer_name, buyer_email, buyer_phone, created_at, paid_at
           FROM orders WHERE buyer_user_id = $1 ORDER BY created_at`),
      q(`SELECT purpose, granted, policy_version, granted_at FROM consents WHERE user_id = $1 ORDER BY granted_at`),
      q(`SELECT ra.code AS race, e.name_th AS event, w.status, w.created_at FROM waitlist_entries w
           JOIN races ra ON ra.id = w.race_id JOIN events e ON e.id = ra.event_id WHERE w.user_id = $1 ORDER BY w.created_at`),
      q(`SELECT t.status, t.to_email, (t.from_user_id = $1) AS sent, t.created_at FROM transfers t
          WHERE t.from_user_id = $1 OR t.to_user_id = $1 ORDER BY t.created_at`),
      q(`SELECT o.name_th AS organization, m.role, m.accepted_at FROM org_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1`),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      account: user,
      savedRunners: profiles,
      registrations,
      orders: orders.map((o) => ({ ...o, total_satang: Number(o.total_satang) })),
      consents,
      waitlist,
      transfers,
      organizerTeams: teams,
    };
  }

  /**
   * Closes the account: saved runners and team memberships go, and the account's own contact details are wiped so it
   * can no longer be signed into or linked to the person. Places for events that have not happened yet must be
   * transferred or refunded first, and a team's last owner must hand the team over. Past registrations stay with
   * their organisers (results, kit records and accounting) under the retention set out in the privacy policy.
   */
  async deleteAccount(userId: string) {
    const blockers = await this.dbs.pool.query<{ upcoming: number; owned: number }>(
      `SELECT (SELECT count(*) FROM registrations r JOIN events e ON e.id = r.event_id LEFT JOIN orders o ON o.id = r.order_id
                WHERE (r.runner_user_id = $1 OR (o.buyer_user_id = $1 AND r.transferred_from_id IS NULL))
                  AND r.status IN ('pending', 'confirmed') AND e.event_date >= current_date)::int AS upcoming,
              (SELECT count(*) FROM org_members m
                WHERE m.user_id = $1 AND m.role = 'owner'
                  AND NOT EXISTS (SELECT 1 FROM org_members x WHERE x.organization_id = m.organization_id AND x.role = 'owner'
                                     AND x.user_id <> $1 AND x.accepted_at IS NOT NULL))::int AS owned`,
      [userId],
    );
    const b = blockers.rows[0];
    if (b.upcoming > 0) {
      throw new ProblemException(409, 'UPCOMING_REGISTRATIONS', 'Transfer or refund your places for upcoming events first', undefined, { count: b.upcoming });
    }
    if (b.owned > 0) throw new ProblemException(409, 'LAST_OWNER', 'Add another owner to your organiser team first', undefined, { count: b.owned });

    const offered = await this.dbs.pool.query<{ id: string }>(`SELECT id FROM waitlist_entries WHERE user_id = $1 AND status IN ('waiting', 'offered')`, [userId]);
    for (const w of offered.rows) await this.waitlist.leave(userId, w.id);

    await this.dbs.transaction(async (_tx, client) => {
      await client.query('DELETE FROM runner_profiles WHERE owner_user_id = $1', [userId]);
      await client.query('DELETE FROM org_members WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO consents (user_id, purpose, policy_version, granted)
         SELECT $1, 'marketing', $2, false WHERE EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'marketing')`,
        [userId, POLICY_VERSION],
      );
      await client.query(
        `UPDATE users SET email = 'deleted-' || id || '@deleted.invalid', phone = NULL, display_name = NULL, avatar_url = NULL,
                          password_hash = NULL, status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE id = $1`,
        [userId],
      );
    });
    return { deleted: true };
  }
}
