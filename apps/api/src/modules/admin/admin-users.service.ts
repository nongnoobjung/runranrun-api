import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from '../org/org-access.service';
import type { PlatformRole } from './admin.service';

const ROLES = ['user', 'support', 'finance', 'admin', 'superadmin'] as const;

export const userListSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'suspended', 'deleted', 'all']).default('all'),
  /** `staff` = every platform role other than user. */
  role: z.enum([...ROLES, 'staff', 'all']).default('all'),
});
export const userRoleSchema = z.object({ role: z.enum(ROLES) });

const like = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

/** Refuses when `userId` is the last of the active superadmins. */
function keepOneSuperadmin(superadmins: string[], userId: string) {
  if (!superadmins.some((id) => id !== userId)) throw new ProblemException(409, 'LAST_SUPERADMIN', 'The platform needs at least one active superadmin');
}

const summary = (u: Record<string, any>) => ({
  id: u.id as string,
  email: u.email as string | null,
  displayName: u.display_name as string | null,
  platformRole: u.platform_role as PlatformRole,
  status: u.status as 'active' | 'suspended' | 'deleted',
  lastLoginAt: u.last_login_at as Date | null,
  createdAt: u.created_at as Date,
});

/**
 * Platform staff looking after accounts: find someone, see what they have on the platform, suspend or reactivate them
 * (AuthGuard signs a suspended account out on its next request), and, for superadmins, change their platform role.
 * Nobody can do this to themselves, and the platform always keeps one active superadmin.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly dbs: DbService) {}

  async list(query: z.infer<typeof userListSchema>) {
    const { rows } = await this.dbs.pool.query(
      `SELECT id, email, display_name, platform_role, status, last_login_at, created_at FROM users
        WHERE ($1::text IS NULL OR email ILIKE $1 OR display_name ILIKE $1)
          AND ($2 = 'all' OR status::text = $2)
          AND ($3 = 'all' OR ($3 = 'staff' AND platform_role <> 'user') OR platform_role::text = $3)
        ORDER BY lower(email) = lower($4) DESC, created_at DESC
        LIMIT 50`,
      [query.q ? like(query.q) : null, query.status, query.role, query.q ?? ''],
    );
    return { items: rows.map(summary) };
  }

  async get(actorId: string, userId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT u.*, (SELECT count(*) FROM registrations r WHERE r.runner_user_id = u.id)::int AS registrations,
              (SELECT count(*) FROM registrations r WHERE r.runner_user_id = u.id AND r.status = 'confirmed')::int AS registrations_active,
              (SELECT count(*) FROM orders o WHERE o.buyer_user_id = u.id)::int AS orders
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u) throw problems.notFound('User');
    const [orders, teams] = await Promise.all([
      this.dbs.pool.query(
        `SELECT o.id, o.order_no, o.status, o.total_satang, o.created_at, e.id AS event_id, e.name_th AS event_name,
                (SELECT count(*) FROM registrations r WHERE r.order_id = o.id)::int AS registrations
           FROM orders o JOIN events e ON e.id = o.event_id
          WHERE o.buyer_user_id = $1 ORDER BY o.created_at DESC LIMIT 20`,
        [userId],
      ),
      this.dbs.pool.query(
        `SELECT o.id, o.name_th, o.status, m.role, m.accepted_at FROM org_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 ORDER BY o.name_th`,
        [userId],
      ),
    ]);
    return {
      ...summary(u),
      statusNote: u.status_note as string | null,
      emailVerifiedAt: u.email_verified_at as Date | null,
      self: u.id === actorId,
      registrations: { total: u.registrations as number, active: u.registrations_active as number },
      orderCount: u.orders as number,
      orders: orders.rows.map((o) => ({
        id: o.id as string,
        orderNo: o.order_no as string,
        status: o.status as string,
        totalSatang: Number(o.total_satang),
        createdAt: o.created_at as Date,
        registrations: o.registrations as number,
        event: { id: o.event_id as string, nameTh: o.event_name as string },
      })),
      teams: teams.rows.map((t) => ({
        id: t.id as string,
        nameTh: t.name_th as string,
        status: t.status as string,
        role: t.role as string,
        accepted: t.accepted_at !== null,
      })),
    };
  }

  /** Signs the account out everywhere and keeps it out until reactivated. Staff accounts need a superadmin. */
  async suspend(actorId: string, actorRole: PlatformRole, userId: string, reason: string) {
    return this.change(actorId, userId, 'admin.user_suspend', async (client, u, superadmins) => {
      if (u.status !== 'active') throw new ProblemException(409, 'INVALID_STATUS', `The account is ${u.status}`);
      if (u.platform_role !== 'user' && actorRole !== 'superadmin') throw problems.forbidden();
      if (u.platform_role === 'superadmin') keepOneSuperadmin(superadmins, userId);
      await client.query(`UPDATE users SET status = 'suspended', status_note = $2, updated_at = now() WHERE id = $1`, [userId, reason]);
      await client.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      return { before: { status: 'active' }, after: { status: 'suspended', reason } };
    });
  }

  async reactivate(actorId: string, actorRole: PlatformRole, userId: string) {
    return this.change(actorId, userId, 'admin.user_reactivate', async (client, u) => {
      if (u.status !== 'suspended') throw new ProblemException(409, 'INVALID_STATUS', 'Only a suspended account can be reactivated');
      if (u.platform_role !== 'user' && actorRole !== 'superadmin') throw problems.forbidden();
      await client.query(`UPDATE users SET status = 'active', status_note = NULL, updated_at = now() WHERE id = $1`, [userId]);
      return { before: { status: 'suspended', reason: u.status_note }, after: { status: 'active' } };
    });
  }

  async setRole(actorId: string, userId: string, role: PlatformRole) {
    return this.change(actorId, userId, 'admin.user_role', async (client, u, superadmins) => {
      if (u.status === 'deleted') throw new ProblemException(409, 'INVALID_STATUS', 'The account is closed');
      if (u.platform_role === role) return null;
      if (u.platform_role === 'superadmin') keepOneSuperadmin(superadmins, userId);
      await client.query('UPDATE users SET platform_role = $2, updated_at = now() WHERE id = $1', [userId, role]);
      return { before: { platformRole: u.platform_role }, after: { platformRole: role } };
    });
  }

  /**
   * Runs `change` on the locked user row and audits what it returns; null = nothing changed. The active superadmins
   * are locked first, always in the same order, so two superadmins demoting each other at once cannot both succeed.
   */
  private async change(
    actorId: string,
    userId: string,
    action: string,
    change: (client: PoolClient, u: Record<string, any>, superadmins: string[]) => Promise<{ before: unknown; after: unknown } | null>,
  ) {
    if (userId === actorId) throw new ProblemException(409, 'CANNOT_CHANGE_SELF', 'Ask another admin to change your own account');
    await this.dbs.transaction(async (_tx, client) => {
      const supers = await client.query<{ id: string }>(`SELECT id FROM users WHERE platform_role = 'superadmin' AND status = 'active' ORDER BY id FOR UPDATE`);
      const { rows } = await client.query('SELECT id, platform_role, status, status_note FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!rows[0]) throw problems.notFound('User');
      const audited = await change(client, rows[0], supers.rows.map((r) => r.id));
      if (audited) await writeAudit(client, { actorId, organizationId: null, action, entityType: 'user', entityId: userId, ...audited });
    });
    return this.get(actorId, userId);
  }
}
