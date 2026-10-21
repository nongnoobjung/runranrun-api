import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { parseCsv } from '../../common/csv';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';

export const resultsImportSchema = z.object({
  /** CSV with a bib column, chip_time and/or gun_time (h:mm:ss) and an optional status (FIN, DNF, DNS, DQ). */
  csv: z.string().min(1).max(5_000_000),
  dryRun: z.boolean().default(true),
});
export const publishSchema = z.object({ published: z.boolean() });

type ResultStatus = 'FIN' | 'DNF' | 'DNS' | 'DQ';
const STATUSES: ResultStatus[] = ['FIN', 'DNF', 'DNS', 'DQ'];
const PREVIEW_TOP = 10;
/** Faster than this is almost certainly a timing mistake (the road world record is about 2:50 per km). */
const FASTEST_PLAUSIBLE_SEC_PER_KM = 150;

interface Row {
  line: number;
  bib: string;
  status: ResultStatus;
  gunMs: number | null;
  chipMs: number | null;
}

interface Runner {
  registration_id: string;
  race_id: string;
  race_code: string;
  distance_km: string;
  cutoff_minutes: number | null;
  name: string;
  gender: 'male' | 'female' | 'other';
  age_group: string | null;
}

export interface Issue {
  line: number;
  bib: string;
  code: string;
}

/** "1:52:08", "52:08", "1:52:08.4" or plain seconds → milliseconds; null when blank, NaN when unreadable. */
export function parseDuration(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const m = v.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/) ?? v.match(/^()()(\d+)(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const [, h, min, s, frac] = m;
  if ((min && Number(s) >= 60) || (h && Number(min) >= 60)) return NaN;
  const ms = ((Number(h || 0) * 60 + Number(min || 0)) * 60 + Number(s)) * 1000 + (frac ? Number(frac.padEnd(3, '0')) : 0);
  return ms > 0 ? ms : NaN;
}

/** Reads the file into rows plus problems that make a line unusable. */
export function parseResultsCsv(text: string): { rows: Row[]; errors: Issue[] } | { error: string } {
  const lines = parseCsv(text.replace(/^﻿/, ''));
  const header = (lines[0] ?? []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const bibCol = col('bib', 'bib_number', 'บิบ');
  const chipCol = col('chip_time', 'chip', 'net_time');
  const gunCol = col('gun_time', 'gun');
  const statusCol = col('status', 'สถานะ');
  if (bibCol < 0 || (chipCol < 0 && gunCol < 0 && statusCol < 0)) return { error: 'The CSV needs a bib column and chip_time, gun_time or status' };
  const rows: Row[] = [];
  const errors: Issue[] = [];
  for (const [i, cells] of lines.slice(1).entries()) {
    const line = i + 2;
    const bib = (cells[bibCol] ?? '').trim().toUpperCase();
    if (cells.every((c) => c.trim() === '')) continue;
    const chipMs = chipCol >= 0 ? parseDuration(cells[chipCol] ?? '') : null;
    const gunMs = gunCol >= 0 ? parseDuration(cells[gunCol] ?? '') : null;
    const rawStatus = statusCol >= 0 ? (cells[statusCol] ?? '').trim().toUpperCase() : '';
    const status = (rawStatus || (chipMs || gunMs ? 'FIN' : 'DNF')) as ResultStatus;
    if (!bib) errors.push({ line, bib, code: 'MISSING_BIB' });
    else if (!STATUSES.includes(status)) errors.push({ line, bib, code: 'INVALID_STATUS' });
    else if (Number.isNaN(chipMs) || Number.isNaN(gunMs)) errors.push({ line, bib, code: 'INVALID_TIME' });
    else if (status === 'FIN' && !chipMs && !gunMs) errors.push({ line, bib, code: 'MISSING_TIME' });
    else rows.push({ line, bib, status, chipMs, gunMs });
  }
  if (rows.length + errors.length === 0) return { error: 'The CSV has no result rows' };
  return { rows, errors };
}

@Injectable()
export class OrgResultsService {
  constructor(private readonly dbs: DbService) {}

  /** Per race: how many finished or did not, the top finishers, plus the last import and whether results are public. */
  async summary(eventId: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const event = await db.query<{ results_published_at: Date | null }>('SELECT results_published_at FROM events WHERE id = $1', [eventId]);
    const counts = await db.query(
      `SELECT ra.id, ra.code, ra.distance_km,
              count(r.id) FILTER (WHERE r.status = 'FIN')::int AS fin, count(r.id) FILTER (WHERE r.status = 'DNF')::int AS dnf,
              count(r.id) FILTER (WHERE r.status = 'DNS')::int AS dns, count(r.id) FILTER (WHERE r.status = 'DQ')::int AS dq,
              (SELECT count(*) FROM registrations g WHERE g.race_id = ra.id AND g.status = 'confirmed')::int AS runners
         FROM races ra LEFT JOIN results r ON r.race_id = ra.id
        WHERE ra.event_id = $1 AND ra.is_active
        GROUP BY ra.id ORDER BY ra.sort_order, ra.distance_km DESC`,
      [eventId],
    );
    const top = await db.query(
      `SELECT * FROM (
         SELECT r.*, row_number() OVER (PARTITION BY r.race_id ORDER BY r.rank_overall) AS n
           FROM results r WHERE r.event_id = $1 AND r.status = 'FIN') t
        WHERE n <= ${PREVIEW_TOP} ORDER BY rank_overall`,
      [eventId],
    );
    const last = await db.query(
      `SELECT i.created_at, i.row_count, i.errors, u.display_name, u.email FROM result_imports i LEFT JOIN users u ON u.id = i.imported_by
        WHERE i.event_id = $1 ORDER BY i.created_at DESC LIMIT 1`,
      [eventId],
    );
    const imp = last.rows[0];
    return {
      publishedAt: event.rows[0]?.results_published_at ?? null,
      races: counts.rows.map((r) => ({
        raceId: r.id,
        code: r.code,
        distanceKm: Number(r.distance_km),
        runners: r.runners,
        counts: { FIN: r.fin, DNF: r.dnf, DNS: r.dns, DQ: r.dq },
        top: top.rows.filter((t) => t.race_id === r.id).map(resultView),
      })),
      lastImport: imp
        ? { at: imp.created_at, rows: imp.row_count, by: imp.display_name ?? imp.email, warnings: (imp.errors?.warnings ?? []) as Issue[] }
        : null,
    };
  }

  /**
   * Checks a timing file against the event's paid runners and, unless it is a dry run or has errors, makes it the event's
   * results: rows are matched by bib, the file replaces the previous results, and ranks are worked out per race (overall,
   * gender, age group by chip time, else gun time). Warnings (over the cut-off, implausibly fast, gun before chip) do not block.
   */
  async import(userId: string, orgId: string, eventId: string, csv: string, dryRun: boolean) {
    const parsed = parseResultsCsv(csv);
    if ('error' in parsed) throw problems.validation(parsed.error);
    return this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const { rows: runners } = await client.query<Runner & { bib_number: string }>(
        `SELECT r.id AS registration_id, r.bib_number, r.race_id, ra.code AS race_code, ra.distance_km, ra.cutoff_minutes, r.gender, ag.code AS age_group,
                COALESCE(NULLIF(trim(coalesce(r.first_name_th, '') || ' ' || coalesce(r.last_name_th, '')), ''), r.first_name_en || ' ' || r.last_name_en) AS name
           FROM registrations r JOIN races ra ON ra.id = r.race_id LEFT JOIN age_groups ag ON ag.id = r.age_group_id
          WHERE r.event_id = $1 AND r.status = 'confirmed' AND r.bib_number IS NOT NULL`,
        [eventId],
      );
      const byBib = new Map(runners.map((r) => [r.bib_number, r]));
      const errors = [...parsed.errors];
      const warnings: Issue[] = [];
      const seen = new Set<string>();
      const matched: (Row & { runner: Runner })[] = [];
      for (const row of parsed.rows) {
        const runner = byBib.get(row.bib);
        if (!runner) errors.push({ line: row.line, bib: row.bib, code: 'BIB_NOT_FOUND' });
        else if (seen.has(row.bib)) errors.push({ line: row.line, bib: row.bib, code: 'DUPLICATE_BIB' });
        else {
          seen.add(row.bib);
          matched.push({ ...row, runner });
          const time = row.chipMs ?? row.gunMs;
          if (row.status === 'FIN' && time) {
            const km = Number(runner.distance_km);
            if (runner.cutoff_minutes && time > runner.cutoff_minutes * 60_000) warnings.push({ line: row.line, bib: row.bib, code: 'OVER_CUTOFF' });
            if (km > 0 && time / 1000 / km < FASTEST_PLAUSIBLE_SEC_PER_KM) warnings.push({ line: row.line, bib: row.bib, code: 'TOO_FAST' });
            if (row.chipMs && row.gunMs && row.gunMs < row.chipMs) warnings.push({ line: row.line, bib: row.bib, code: 'GUN_BEFORE_CHIP' });
          }
        }
      }
      errors.sort((a, b) => a.line - b.line);
      const perRace = new Map<string, { code: string; FIN: number; DNF: number; DNS: number; DQ: number }>();
      for (const m of matched) {
        const c = perRace.get(m.runner.race_id) ?? { code: m.runner.race_code, FIN: 0, DNF: 0, DNS: 0, DQ: 0 };
        c[m.status] += 1;
        perRace.set(m.runner.race_id, c);
      }
      const result = { rows: parsed.rows.length + parsed.errors.length, matched: matched.length, errors, warnings, races: [...perRace.values()], applied: false };
      if (dryRun || errors.length) return result;

      const published = (await client.query<{ p: boolean }>('SELECT results_published_at IS NOT NULL AS p FROM events WHERE id = $1', [eventId])).rows[0].p;
      const imp = await client.query<{ id: string }>(
        `INSERT INTO result_imports (event_id, source, row_count, error_count, errors, imported_by) VALUES ($1, 'csv', $2, 0, $3, $4) RETURNING id`,
        [eventId, result.rows, JSON.stringify({ warnings }), userId],
      );
      // The file is the whole truth for the event, so it replaces what was there (a bib may even have moved race).
      await client.query('DELETE FROM results WHERE event_id = $1', [eventId]);
      for (const m of matched) {
        const time = m.chipMs ?? m.gunMs;
        const km = Number(m.runner.distance_km);
        await client.query(
          `INSERT INTO results (event_id, race_id, registration_id, import_id, bib_number, display_name, gender, age_group_code, status,
                                gun_time_ms, chip_time_ms, pace_sec_per_km, is_published)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            eventId, m.runner.race_id, m.runner.registration_id, imp.rows[0].id, m.bib, m.runner.name, m.runner.gender, m.runner.age_group, m.status,
            m.gunMs, m.chipMs, m.status === 'FIN' && time && km > 0 ? Math.round(time / 1000 / km) : null, published,
          ],
        );
      }
      await client.query(
        `UPDATE results r SET rank_overall = x.ro, rank_gender = x.rg, rank_age_group = x.ra
           FROM (SELECT id,
                   rank() OVER (PARTITION BY race_id ORDER BY COALESCE(chip_time_ms, gun_time_ms)) AS ro,
                   rank() OVER (PARTITION BY race_id, gender ORDER BY COALESCE(chip_time_ms, gun_time_ms)) AS rg,
                   rank() OVER (PARTITION BY race_id, gender, age_group_code ORDER BY COALESCE(chip_time_ms, gun_time_ms)) AS ra
                   FROM results WHERE event_id = $1 AND status = 'FIN') x
          WHERE r.id = x.id`,
        [eventId],
      );
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, eventId, action: 'results.import', entityType: 'result_import', entityId: imp.rows[0].id,
        after: { rows: result.rows, matched: matched.length, warnings: warnings.length },
      });
      return { ...result, applied: true };
    });
  }

  /** Shows the results on the event page, or takes them down again. */
  async publish(userId: string, orgId: string, eventId: string, published: boolean) {
    return this.dbs.transaction(async (_tx, client) => {
      const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM results WHERE event_id = $1', [eventId]);
      if (published && count.rows[0].n === 0) throw new ProblemException(409, 'NO_RESULTS', 'Import results before publishing them');
      await client.query(`UPDATE events SET results_published_at = CASE WHEN $2 THEN COALESCE(results_published_at, now()) END, updated_at = now() WHERE id = $1`, [
        eventId, published,
      ]);
      await client.query('UPDATE results SET is_published = $2 WHERE event_id = $1', [eventId, published]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: published ? 'results.publish' : 'results.unpublish', entityType: 'event', entityId: eventId });
      return this.summary(eventId, client);
    });
  }
}

export function resultView(r: Record<string, any>) {
  return {
    bib: r.bib_number as string,
    name: r.display_name as string,
    gender: r.gender as 'male' | 'female' | 'other' | null,
    ageGroup: r.age_group_code as string | null,
    status: r.status as ResultStatus,
    gunTimeMs: r.gun_time_ms as number | null,
    chipTimeMs: r.chip_time_ms as number | null,
    paceSecPerKm: r.pace_sec_per_km as number | null,
    rankOverall: r.rank_overall as number | null,
    rankGender: r.rank_gender as number | null,
    rankAgeGroup: r.rank_age_group as number | null,
  };
}
