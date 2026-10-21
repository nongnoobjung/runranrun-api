import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { problems } from '../../common/problem';
import { DbService } from '../../db/db.service';

export type OrgRole = 'owner' | 'admin' | 'finance' | 'staff' | 'viewer';

/**
 * What each organizer role may do. Everyone in the team can look at the dashboard and the runner list;
 * runner ID numbers and exports carry personal data, so only owners and admins get them.
 */
const PERMISSIONS = {
  view: ['owner', 'admin', 'finance', 'staff', 'viewer'],
  manage_event: ['owner', 'admin'],
  view_pii: ['owner', 'admin'],
  checkin: ['owner', 'admin', 'staff'],
} as const satisfies Record<string, readonly OrgRole[]>;

export type OrgPermission = keyof typeof PERMISSIONS;

export interface OrgMembership {
  organizationId: string;
  role: OrgRole;
}

export interface OrgEvent extends OrgMembership {
  eventId: string;
  status: string;
}

@Injectable()
export class OrgAccessService {
  constructor(private readonly dbs: DbService) {}

  /** The caller's role in the organisation, or 404 so outsiders cannot tell which organisations exist. */
  async require(userId: string, orgId: string, permission: OrgPermission): Promise<OrgMembership> {
    const { rows } = await this.dbs.pool.query<{ role: OrgRole }>(
      `SELECT role FROM org_members WHERE organization_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
      [orgId, userId],
    );
    const role = rows[0]?.role;
    if (!role) throw problems.notFound('Organization');
    if (!(PERMISSIONS[permission] as readonly OrgRole[]).includes(role)) throw problems.forbidden();
    return { organizationId: orgId, role };
  }

  /** Same as require, plus the event must belong to that organisation. */
  async requireEvent(userId: string, orgId: string, eventId: string, permission: OrgPermission): Promise<OrgEvent> {
    const membership = await this.require(userId, orgId, permission);
    const { rows } = await this.dbs.pool.query<{ status: string }>(
      `SELECT status FROM events WHERE id = $1 AND organization_id = $2`,
      [eventId, orgId],
    );
    if (!rows[0]) throw problems.notFound('Event');
    return { ...membership, eventId, status: rows[0].status };
  }
}

export interface AuditEntry {
  actorId: string;
  organizationId: string;
  eventId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Appends to audit_logs; pass the transaction's client so the entry commits or rolls back with the change. */
export async function writeAudit(db: Pick<PoolClient, 'query'>, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_type, actor_id, organization_id, event_id, action, entity_type, entity_id, before_data, after_data)
     VALUES ('user', $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actorId, entry.organizationId, entry.eventId ?? null, entry.action, entry.entityType, entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
