import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from '../org/org-access.service';

export const feeSchema = z.object({
  percentBps: z.number().int().min(0).max(10_000),
  fixedPerRegistrationSatang: z.number().int().min(0).max(1_000_000),
  /** When the rate starts; now when left out. Orders created before it keep the rate they were made with. */
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

export interface FeeRow {
  id: string;
  percentBps: number;
  fixedPerRegistrationSatang: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  createdBy: string | null;
  state: 'scheduled' | 'current' | 'ended';
}

const ROWS = `SELECT f.id, f.organization_id, f.percent_bps, f.fixed_per_reg_satang, f.effective_from, f.effective_to, f.created_at,
                     u.email AS created_by, o.name_th AS org_name, f.effective_from > now() AS scheduled,
                     f.effective_from <= now() AND (f.effective_to IS NULL OR f.effective_to > now()) AS in_force
                FROM platform_fees f LEFT JOIN users u ON u.id = f.created_by LEFT JOIN organizations o ON o.id = f.organization_id`;

/**
 * Rows of one scope (an organisation, or the platform default), newest first. Only the latest row in force is
 * current, as in OrdersService.platformFeePlan.
 */
function feeRows(rows: Record<string, any>[]): FeeRow[] {
  let current = false;
  return rows.map((r) => {
    const state = r.scheduled ? 'scheduled' : r.in_force && !current ? 'current' : 'ended';
    if (state === 'current') current = true;
    return {
      id: r.id as string,
      percentBps: r.percent_bps as number,
      fixedPerRegistrationSatang: Number(r.fixed_per_reg_satang),
      effectiveFrom: r.effective_from as Date,
      effectiveTo: r.effective_to as Date | null,
      createdAt: r.created_at as Date,
      createdBy: r.created_by as string | null,
      state,
    };
  });
}

const rate = (r: FeeRow | undefined) => (r ? { percentBps: r.percentBps, fixedPerRegistrationSatang: r.fixedPerRegistrationSatang } : null);

/**
 * The platform's fee on each order (platform_fees): a default, and organisations' own rates that take its place.
 * A change never edits a row: the rate in force is closed where the new one starts, so the history stays. Orders
 * keep the fee worked out when they were created (orders.platform_fee_satang).
 */
@Injectable()
export class AdminFeesService {
  constructor(private readonly dbs: DbService) {}

  /** The default with its history, and every organisation with a rate of its own now or scheduled. */
  async list() {
    const [defaults, own] = await Promise.all([
      this.dbs.pool.query(`${ROWS} WHERE f.organization_id IS NULL ORDER BY f.effective_from DESC LIMIT 50`),
      this.dbs.pool.query(
        `${ROWS} WHERE f.organization_id IS NOT NULL AND (f.effective_to IS NULL OR f.effective_to > now())
          ORDER BY o.name_th, f.organization_id, f.effective_from DESC`,
      ),
    ]);
    const byOrg = new Map<string, { id: string; nameTh: string; rows: Record<string, any>[] }>();
    for (const r of own.rows) {
      const o = byOrg.get(r.organization_id) ?? { id: r.organization_id as string, nameTh: r.org_name as string, rows: [] };
      o.rows.push(r);
      byOrg.set(o.id, o);
    }
    const history = feeRows(defaults.rows);
    return {
      default: { current: history.find((r) => r.state === 'current') ?? null, history },
      organizations: [...byOrg.values()].map((o) => {
        const rows = feeRows(o.rows);
        return { id: o.id, nameTh: o.nameTh, current: rows.find((r) => r.state === 'current') ?? null, scheduled: rows.filter((r) => r.state === 'scheduled') };
      }),
    };
  }

  /** What new orders of the organisation pay now (its own rate, else the default), and its own rates over time. */
  async forOrganization(orgId: string) {
    const [own, defaults] = await Promise.all([
      this.dbs.pool.query(`${ROWS} WHERE f.organization_id = $1 ORDER BY f.effective_from DESC LIMIT 50`, [orgId]),
      this.dbs.pool.query(`${ROWS} WHERE f.organization_id IS NULL ORDER BY f.effective_from DESC LIMIT 50`),
    ]);
    const history = feeRows(own.rows);
    const ownCurrent = history.find((r) => r.state === 'current');
    const defaultCurrent = feeRows(defaults.rows).find((r) => r.state === 'current');
    const current = ownCurrent ?? defaultCurrent;
    return {
      current: current ? { ...rate(current)!, effectiveFrom: current.effectiveFrom, source: ownCurrent ? ('organization' as const) : ('default' as const) } : null,
      history,
    };
  }

  /** A new rate for the organisation, or the default when `orgId` is null, from now or from a later time. */
  async set(actorId: string, orgId: string | null, input: z.infer<typeof feeSchema>) {
    const id = await this.dbs.transaction(async (_tx, client) => {
      if (orgId) {
        const exists = await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
        if (!exists.rowCount) throw problems.notFound('Organisation');
      }
      // One change at a time per scope, so two admins cannot leave overlapping rates.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`platform_fees:${orgId ?? 'default'}`]);
      const { rows: when } = await client.query<{ from: Date; past: boolean }>(
        `SELECT COALESCE($1::timestamptz, now()) AS from, $1::timestamptz < now() - interval '1 minute' AS past`,
        [input.effectiveFrom ?? null],
      );
      if (when[0].past) throw problems.validation('effectiveFrom must not be in the past');
      const from = when[0].from;

      const before = await client.query(
        `SELECT percent_bps, fixed_per_reg_satang FROM platform_fees
          WHERE organization_id IS NOT DISTINCT FROM $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
          ORDER BY effective_from DESC LIMIT 1`,
        [orgId, from],
      );
      // Rates scheduled from the same time or later never applied to an order; the new one replaces them.
      await client.query('DELETE FROM platform_fees WHERE organization_id IS NOT DISTINCT FROM $1 AND effective_from >= $2', [orgId, from]);
      await client.query(
        `UPDATE platform_fees SET effective_to = $2
          WHERE organization_id IS NOT DISTINCT FROM $1 AND effective_from < $2 AND (effective_to IS NULL OR effective_to > $2)`,
        [orgId, from],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO platform_fees (organization_id, percent_bps, fixed_per_reg_satang, effective_from, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, input.percentBps, input.fixedPerRegistrationSatang, from, actorId],
      );
      const b = before.rows[0];
      await writeAudit(client, {
        actorId, organizationId: orgId, action: 'admin.platform_fee_set', entityType: 'platform_fee', entityId: rows[0].id,
        before: b ? { percentBps: b.percent_bps, fixedPerRegistrationSatang: Number(b.fixed_per_reg_satang) } : undefined,
        after: { percentBps: input.percentBps, fixedPerRegistrationSatang: input.fixedPerRegistrationSatang, effectiveFrom: from },
      });
      return rows[0].id;
    });
    return { id, ...(orgId ? await this.forOrganization(orgId) : (await this.list()).default) };
  }

  /** The organisation goes back to the default rate from now; anything it had scheduled is dropped. */
  async clear(actorId: string, orgId: string) {
    await this.dbs.transaction(async (_tx, client) => {
      const exists = await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      if (!exists.rowCount) throw problems.notFound('Organisation');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`platform_fees:${orgId}`]);
      const scheduled = await client.query('DELETE FROM platform_fees WHERE organization_id = $1 AND effective_from > now()', [orgId]);
      const ended = await client.query<{ percent_bps: number; fixed_per_reg_satang: string }>(
        `UPDATE platform_fees SET effective_to = now()
          WHERE organization_id = $1 AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
          RETURNING percent_bps, fixed_per_reg_satang`,
        [orgId],
      );
      if (!scheduled.rowCount && !ended.rowCount) throw new ProblemException(409, 'NO_OWN_FEE', 'The organisation already uses the default rate');
      const b = ended.rows[0];
      await writeAudit(client, {
        actorId, organizationId: orgId, action: 'admin.platform_fee_clear', entityType: 'organization', entityId: orgId,
        before: b ? { percentBps: b.percent_bps, fixedPerRegistrationSatang: Number(b.fixed_per_reg_satang) } : undefined,
        after: { scheduledDropped: scheduled.rowCount },
      });
    });
    return this.forOrganization(orgId);
  }
}
