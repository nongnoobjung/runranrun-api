import { Injectable } from '@nestjs/common';
import { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCsv } from '../../common/csv';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { assignNextBib } from '../bibs/next-bib';
import { writeAudit } from './org-access.service';

/** Bibs are printed, so keep them short: letters, digits and dashes. Stored upper case. */
const bibSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,10}$/, '1–10 letters, digits or dashes');

export const setBibSchema = z.object({ bibNumber: bibSchema.nullable() });
export const assignSchema = z.object({ raceId: z.string().uuid().optional() });
export const importSchema = z.object({
  /** CSV with a registration_no and a bib column, e.g. the runner export with the bib column filled in. */
  csv: z.string().min(1).max(1_000_000),
  dryRun: z.boolean().default(true),
});

const WAITING_LIMIT = 200;

interface ImportRow {
  line: number;
  registrationNo: string;
  bib: string;
}

@Injectable()
export class OrgBibsService {
  constructor(private readonly dbs: DbService) {}

  /** Each race's range and how many paid runners have a number, plus the paid runners still without one. */
  async overview(eventId: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const races = await db.query(
      `SELECT ra.id, ra.code, ra.bib_prefix, ra.bib_start, ra.bib_end, ra.bib_next, ra.bib_auto_assign,
              count(r.id) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
              count(r.id) FILTER (WHERE r.status = 'confirmed' AND r.bib_number IS NOT NULL)::int AS assigned
         FROM races ra LEFT JOIN registrations r ON r.race_id = ra.id
        WHERE ra.event_id = $1 AND ra.is_active
        GROUP BY ra.id ORDER BY ra.sort_order, ra.code`,
      [eventId],
    );
    const waiting = await db.query(
      `SELECT r.id, r.registration_no, r.first_name_th, r.last_name_th, r.first_name_en, r.last_name_en, ra.code AS race_code, r.confirmed_at
         FROM registrations r JOIN races ra ON ra.id = r.race_id
        WHERE r.event_id = $1 AND r.status = 'confirmed' AND r.bib_number IS NULL
        ORDER BY r.confirmed_at, r.registration_no LIMIT ${WAITING_LIMIT}`,
      [eventId],
    );
    const items = races.rows.map((r) => {
      const next = r.bib_next ?? r.bib_start;
      return {
        raceId: r.id,
        code: r.code,
        prefix: r.bib_prefix,
        start: r.bib_start,
        end: r.bib_end,
        /** The number the next paid runner gets; null when the race has no range. */
        next: r.bib_start === null ? null : next,
        autoAssign: r.bib_auto_assign,
        rangeFull: r.bib_start !== null && r.bib_end !== null && next > r.bib_end,
        confirmed: r.confirmed,
        assigned: r.assigned,
        waiting: r.confirmed - r.assigned,
      };
    });
    return {
      races: items,
      totals: { confirmed: items.reduce((s, r) => s + r.confirmed, 0), assigned: items.reduce((s, r) => s + r.assigned, 0) },
      waiting: waiting.rows.map((r) => ({
        id: r.id,
        registrationNo: r.registration_no,
        name: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : `${r.first_name_en} ${r.last_name_en}`,
        raceCode: r.race_code,
      })),
    };
  }

  /** Gives, changes or clears one paid runner's number by hand. Any free number is allowed (VIPs, invited runners). */
  async set(userId: string, orgId: string, eventId: string, registrationId: string, bibNumber: string | null) {
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query<{ status: string; bib_number: string | null }>(
          'SELECT status, bib_number FROM registrations WHERE id = $1 AND event_id = $2 FOR UPDATE',
          [registrationId, eventId],
        );
        const reg = rows[0];
        if (!reg) throw new ProblemException(404, 'REGISTRATION_NOT_FOUND', 'No runner in this event matches that registration');
        if (reg.status !== 'confirmed') throw new ProblemException(409, 'NOT_CONFIRMED', 'Only paid runners get a bib number');
        if (reg.bib_number !== bibNumber) {
          await client.query('UPDATE registrations SET bib_number = $2, bib_assigned_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1', [
            registrationId, bibNumber,
          ]);
          await writeAudit(client, {
            actorId: userId, organizationId: orgId, eventId, action: 'bib.set', entityType: 'registration', entityId: registrationId,
            before: { bibNumber: reg.bib_number }, after: { bibNumber },
          });
        }
        return { id: registrationId, bibNumber };
      });
    } catch (err) {
      throw await this.translate(err, eventId, bibNumber);
    }
  }

  /** Numbers every paid runner still without a bib from their race's range, oldest payment first. */
  async assignWaiting(userId: string, orgId: string, eventId: string, raceId?: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query<{ id: string; race_id: string }>(
        `SELECT id, race_id FROM registrations
          WHERE event_id = $1 AND status = 'confirmed' AND bib_number IS NULL AND ($2::uuid IS NULL OR race_id = $2)
          ORDER BY confirmed_at, registration_no FOR UPDATE`,
        [eventId, raceId ?? null],
      );
      const full = new Set<string>();
      let assigned = 0;
      for (const r of rows) {
        if (full.has(r.race_id)) continue;
        const bib = await assignNextBib(client, { id: r.id, raceId: r.race_id, eventId }, false);
        if (bib) assigned += 1;
        else full.add(r.race_id); // no range, or it ran out: the rest of this race stays waiting
      }
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'bibs.assign', entityType: 'event', entityId: eventId, after: { raceId: raceId ?? null, assigned } });
      return { assigned, ...(await this.overview(eventId, client)) };
    });
  }

  /**
   * Sets many numbers from a CSV. Always checks the whole file first and reports every problem by line;
   * nothing is written on a dry run or when any line is wrong. Numbers can swap between runners in the file.
   */
  async import(userId: string, orgId: string, eventId: string, csv: string, dryRun: boolean) {
    const parsed = parseBibCsv(csv);
    if ('error' in parsed) throw problems.validation(parsed.error);
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        // Lock the event's numbered runners so the check below still holds when the changes are written.
        const { rows } = await client.query<{ id: string; registration_no: string; status: string; bib_number: string | null; name: string }>(
          `SELECT id, registration_no, status, bib_number,
                  COALESCE(NULLIF(trim(coalesce(first_name_th, '') || ' ' || coalesce(last_name_th, '')), ''), first_name_en || ' ' || last_name_en) AS name
             FROM registrations WHERE event_id = $1 ORDER BY id FOR UPDATE`,
          [eventId],
        );
        const byNo = new Map(rows.map((r) => [r.registration_no, r]));
        const holder = new Map(rows.filter((r) => r.bib_number).map((r) => [r.bib_number!, r.id]));
        const errors: { line: number; registrationNo: string; bib: string; message: string }[] = [];
        const seenRegs = new Set<string>();
        const seenBibs = new Map<string, number>();
        const changes: { line: number; id: string; registrationNo: string; name: string; from: string | null; to: string }[] = [];
        for (const row of parsed.rows) {
          const fail = (code: string) => errors.push({ ...row, message: code });
          const reg = byNo.get(row.registrationNo);
          const bib = bibSchema.safeParse(row.bib);
          if (!reg) fail('REGISTRATION_NOT_FOUND');
          else if (reg.status !== 'confirmed') fail('NOT_CONFIRMED');
          else if (!bib.success) fail('INVALID_BIB');
          else if (seenRegs.has(reg.id)) fail('DUPLICATE_REGISTRATION');
          else if (seenBibs.has(bib.data)) fail('DUPLICATE_BIB');
          else {
            seenRegs.add(reg.id);
            seenBibs.set(bib.data, row.line);
            if (reg.bib_number !== bib.data) {
              changes.push({ line: row.line, id: reg.id, registrationNo: reg.registration_no, name: reg.name, from: reg.bib_number, to: bib.data });
            }
          }
        }
        // A number may move to someone in the file, but not to a runner who keeps it because they are not in the file.
        for (const c of changes) {
          const owner = holder.get(c.to);
          if (owner && owner !== c.id && !seenRegs.has(owner)) {
            errors.push({ line: c.line, registrationNo: c.registrationNo, bib: c.to, message: 'BIB_TAKEN' });
          }
        }
        errors.sort((a, b) => a.line - b.line);
        const result = { rows: parsed.rows.length, changes: changes.map(({ id: _id, ...c }) => c), errors, applied: false };
        if (dryRun || errors.length || changes.length === 0) return result;

        // Clear first, then set, so numbers can swap between runners without tripping the unique index.
        await client.query('UPDATE registrations SET bib_number = NULL WHERE id = ANY($1::uuid[])', [changes.map((c) => c.id)]);
        for (const c of changes) {
          await client.query('UPDATE registrations SET bib_number = $2, bib_assigned_at = now() WHERE id = $1', [c.id, c.to]);
        }
        await writeAudit(client, {
          actorId: userId, organizationId: orgId, eventId, action: 'bibs.import', entityType: 'event', entityId: eventId,
          after: { changes: changes.map((c) => ({ registrationNo: c.registrationNo, from: c.from, to: c.to })) },
        });
        return { ...result, applied: true };
      });
    } catch (err) {
      throw await this.translate(err, eventId, null);
    }
  }

  private async translate(err: unknown, eventId: string, bibNumber: string | null): Promise<unknown> {
    if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_registrations_event_bib') {
      const holder = bibNumber
        ? (await this.dbs.pool.query<{ registration_no: string }>('SELECT registration_no FROM registrations WHERE event_id = $1 AND bib_number = $2', [eventId, bibNumber])).rows[0]
        : undefined;
      return new ProblemException(409, 'BIB_TAKEN', 'Another runner in this event already has that bib number', undefined, {
        registrationNo: holder?.registration_no ?? null,
      });
    }
    return err;
  }
}

/** Finds the registration_no and bib columns by header; quoted fields and a UTF-8 BOM are fine. */
export function parseBibCsv(text: string): { rows: ImportRow[] } | { error: string } {
  const lines = parseCsv(text.replace(/^﻿/, ''));
  const header = (lines[0] ?? []).map((h) => h.trim().toLowerCase());
  const noCol = header.findIndex((h) => h === 'registration_no' || h === 'เลขสมัคร');
  const bibCol = header.findIndex((h) => h === 'bib' || h === 'bib_number' || h === 'บิบ');
  if (noCol < 0 || bibCol < 0) return { error: 'The CSV needs registration_no and bib columns' };
  const rows: ImportRow[] = [];
  for (const [i, cells] of lines.slice(1).entries()) {
    const registrationNo = (cells[noCol] ?? '').trim().toUpperCase();
    const bib = (cells[bibCol] ?? '').trim();
    // Blank bib = leave that runner as they are, so the full export can be re-imported with some rows filled in.
    if (!bib) continue;
    rows.push({ line: i + 2, registrationNo, bib });
  }
  if (rows.length === 0) return { error: 'The CSV has no rows with a bib number' };
  if (rows.length > 20_000) return { error: 'Import at most 20,000 rows at a time' };
  return { rows };
}
