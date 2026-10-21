import { PoolClient } from 'pg';

/**
 * Gives a registration the race's next free bib number. The UPDATE on races locks the row, so
 * concurrent callers for the same race get consecutive numbers; numbers already taken in the event
 * (given by hand or imported) are skipped. Returns the number, or null when the race has no range,
 * the range is used up, or `autoOnly` is set and the race is numbered by hand.
 */
export async function assignNextBib(
  client: PoolClient,
  registration: { id: string; raceId: string; eventId: string },
  autoOnly: boolean,
): Promise<string | null> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const next = await client.query<{ bib: string }>(
      `UPDATE races SET bib_next = COALESCE(bib_next, bib_start) + 1
        WHERE id = $1 AND ($2::boolean IS FALSE OR bib_auto_assign) AND bib_start IS NOT NULL
          AND COALESCE(bib_next, bib_start) <= COALESCE(bib_end, 2147483646)
        RETURNING COALESCE(bib_prefix, '') || lpad((bib_next - 1)::text, 4, '0') AS bib`,
      [registration.raceId, autoOnly],
    );
    if (next.rowCount === 0) return null;
    const bib = next.rows[0].bib;
    const taken = await client.query('SELECT 1 FROM registrations WHERE event_id = $1 AND bib_number = $2', [registration.eventId, bib]);
    if (taken.rowCount) continue;
    await client.query('UPDATE registrations SET bib_number = $2, bib_assigned_at = now() WHERE id = $1', [registration.id, bib]);
    return bib;
  }
  return null;
}
