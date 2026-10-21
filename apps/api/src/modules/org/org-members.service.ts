import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { OrgRole, writeAudit } from './org-access.service';

const roleSchema = z.enum(['owner', 'admin', 'finance', 'staff', 'viewer']);

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: roleSchema,
});

export const memberRoleSchema = z.object({ role: roleSchema });

const LIST_SQL = `
  SELECT m.id, m.user_id, m.role, m.accepted_at, m.created_at,
         COALESCE(u.email, m.invited_email) AS email, u.display_name, u.last_login_at
    FROM org_members m LEFT JOIN users u ON u.id = m.user_id`;

@Injectable()
export class OrgMembersService {
  constructor(private readonly dbs: DbService) {}

  async list(orgId: string, callerId: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const { rows } = await db.query(
      `${LIST_SQL} WHERE m.organization_id = $1
        ORDER BY m.accepted_at IS NULL, array_position(ARRAY['owner','admin','finance','staff','viewer']::org_role[], m.role), m.created_at`,
      [orgId],
    );
    return { items: rows.map((r) => view(r, callerId)) };
  }

  /** Records an invitation; the person joins the first time they sign in with that email (see acceptInvites). */
  async invite(userId: string, orgId: string, input: z.infer<typeof inviteSchema>) {
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const existing = await client.query(
          `SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email = $2`,
          [orgId, input.email],
        );
        if (existing.rows[0]) throw new ProblemException(409, 'ALREADY_MEMBER', 'This person is already in the team');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO org_members (organization_id, invited_email, role, invited_by) VALUES ($1, $2, $3, $4) RETURNING id`,
          [orgId, input.email, input.role, userId],
        );
        await writeAudit(client, { actorId: userId, organizationId: orgId, action: 'member.invite', entityType: 'org_member', entityId: rows[0].id, after: input });
        return this.list(orgId, userId, client);
      });
    } catch (err) {
      throw translate(err);
    }
  }

  async changeRole(userId: string, orgId: string, memberId: string, role: OrgRole) {
    return this.dbs.transaction(async (_tx, client) => {
      const member = await lockMember(client, orgId, memberId);
      if (member.role === role) return this.list(orgId, userId, client);
      if (member.role === 'owner' && member.accepted_at) await assertAnotherOwner(client, orgId, memberId);
      await client.query('UPDATE org_members SET role = $2, updated_at = now() WHERE id = $1', [memberId, role]);
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, action: 'member.role', entityType: 'org_member', entityId: memberId,
        before: { role: member.role }, after: { role },
      });
      return this.list(orgId, userId, client);
    });
  }

  /** Removes a member or withdraws an invitation. */
  async remove(userId: string, orgId: string, memberId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const member = await lockMember(client, orgId, memberId);
      if (member.role === 'owner' && member.accepted_at) await assertAnotherOwner(client, orgId, memberId);
      await client.query('DELETE FROM org_members WHERE id = $1', [memberId]);
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, action: member.accepted_at ? 'member.remove' : 'member.uninvite', entityType: 'org_member', entityId: memberId,
        before: { role: member.role, email: member.email },
      });
      return this.list(orgId, userId, client);
    });
  }

  /**
   * Turns open invitations for the caller's email into memberships. Stands in for an emailed invite link
   * until real sign-in lands; it relies on the email belonging to the person who signed in.
   */
  async acceptInvites(userId: string): Promise<void> {
    await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query<{ id: string; organization_id: string; role: OrgRole }>(
        `UPDATE org_members m SET user_id = u.id, accepted_at = now(), updated_at = now()
           FROM users u
          WHERE u.id = $1 AND m.invited_email = u.email AND m.user_id IS NULL AND m.accepted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM org_members x WHERE x.organization_id = m.organization_id AND x.user_id = u.id)
          RETURNING m.id, m.organization_id, m.role`,
        [userId],
      );
      for (const r of rows) {
        await writeAudit(client, { actorId: userId, organizationId: r.organization_id, action: 'member.accept', entityType: 'org_member', entityId: r.id, after: { role: r.role } });
      }
    });
  }
}

async function lockMember(client: PoolClient, orgId: string, memberId: string) {
  const { rows } = await client.query<{ role: OrgRole; accepted_at: Date | null; email: string | null }>(
    `SELECT m.role, m.accepted_at, COALESCE(u.email, m.invited_email) AS email
       FROM org_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = $1 AND m.organization_id = $2 FOR UPDATE OF m`,
    [memberId, orgId],
  );
  if (!rows[0]) throw problems.notFound('Member');
  return rows[0];
}

/** Locks every owner row so two owners demoting each other at once cannot leave the organisation without one. */
async function assertAnotherOwner(client: PoolClient, orgId: string, memberId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM org_members WHERE organization_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL ORDER BY id FOR UPDATE`,
    [orgId],
  );
  if (!rows.some((r) => r.id !== memberId)) {
    throw new ProblemException(409, 'LAST_OWNER', 'The organisation needs at least one owner');
  }
}

function view(m: Record<string, any>, callerId: string) {
  return {
    id: m.id,
    email: m.email,
    name: m.display_name,
    role: m.role as OrgRole,
    status: m.accepted_at ? ('active' as const) : ('invited' as const),
    you: m.user_id === callerId,
    invitedAt: m.created_at,
    acceptedAt: m.accepted_at,
    lastLoginAt: m.last_login_at,
  };
}

function translate(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'uq_org_members_invite') return new ProblemException(409, 'ALREADY_INVITED', 'This email already has an open invitation');
  return err;
}
