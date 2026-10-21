import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { resultView } from '../org/org-results.service';

export interface ResultsIndexQuery {
  q?: string;
  limit: number;
  offset: number;
}

/** Only results the organiser has published, on events the public can see. */
const PUBLIC = `e.status IN ('published', 'closed') AND e.results_published_at IS NOT NULL AND r.is_published`;

/** One runner's result with the event and race it belongs to, as search and "my results" return it. */
const RESULT_SQL = `
  SELECT r.*, e.slug AS event_slug, e.name_th AS event_name, e.event_date::text AS event_date,
         ra.code AS race_code, ra.name_th AS race_name, ra.distance_km
    FROM results r
    JOIN events e ON e.id = r.event_id
    JOIN races ra ON ra.id = r.race_id`;

const like = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

function runnerResult(r: Record<string, any>) {
  return {
    event: { slug: r.event_slug as string, name: r.event_name as string, eventDate: r.event_date as string },
    race: { id: r.race_id as string, code: r.race_code as string, name: r.race_name as string, distanceKm: Number(r.distance_km) },
    ...resultView(r),
  };
}

@Injectable()
export class ResultsService {
  constructor(private readonly dbs: DbService) {}

  /** Events with published results, latest race day first, with finishers per race. */
  async list(query: ResultsIndexQuery) {
    const params: unknown[] = [];
    let search = '';
    if (query.q) {
      params.push(like(query.q));
      search = `AND (e.name_th ILIKE $1 OR e.name_en ILIKE $1)`;
    }
    params.push(query.limit, query.offset);
    const { rows } = await this.dbs.pool.query(
      `SELECT e.slug, e.name_th, e.name_en, e.event_type, e.event_date::text AS event_date, e.province_code, e.venue_name,
              e.cover_image_url, e.results_published_at,
              json_agg(json_build_object('id', ra.id, 'code', ra.code, 'name', ra.name_th, 'distanceKm', ra.distance_km, 'finishers', x.finishers)
                       ORDER BY ra.sort_order, ra.distance_km DESC) AS races,
              count(*) OVER ()::int AS total
         FROM events e
         JOIN races ra ON ra.event_id = e.id
         JOIN LATERAL (SELECT count(*) FILTER (WHERE r.status = 'FIN')::int AS finishers, count(*) AS n
                         FROM results r WHERE r.race_id = ra.id AND r.is_published) x ON x.n > 0
        WHERE e.status IN ('published', 'closed') AND e.results_published_at IS NOT NULL ${search}
        GROUP BY e.id
        ORDER BY e.event_date DESC, e.results_published_at DESC, e.slug
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((e) => {
        const races = (e.races as { id: string; code: string; name: string; distanceKm: string; finishers: number }[]).map((r) => ({
          ...r,
          distanceKm: Number(r.distanceKm),
        }));
        return {
          slug: e.slug,
          name: { th: e.name_th, en: e.name_en },
          type: e.event_type,
          eventDate: e.event_date,
          province: e.province_code,
          venue: e.venue_name,
          coverImageUrl: e.cover_image_url,
          publishedAt: e.results_published_at,
          finishers: races.reduce((s, r) => s + r.finishers, 0),
          races,
        };
      }),
    };
  }

  /** A runner's results across every published event, by exact bib or part of the name; bib matches come first. */
  async search(q: string, limit: number) {
    const { rows } = await this.dbs.pool.query(
      `${RESULT_SQL}
        WHERE ${PUBLIC} AND (r.display_name ILIKE $1 OR r.bib_number = $2)
        ORDER BY (r.bib_number = $2) DESC, e.event_date DESC, (r.status = 'FIN') DESC, r.rank_overall NULLS LAST, r.display_name
        LIMIT $3`,
      [like(q), q.toUpperCase(), limit + 1],
    );
    return { items: rows.slice(0, limit).map(runnerResult), hasMore: rows.length > limit };
  }

  /** Published results of the places the user runs or bought for others, latest first. */
  async mine(userId: string) {
    const { rows } = await this.dbs.pool.query(
      `${RESULT_SQL}
         JOIN registrations g ON g.id = r.registration_id
         LEFT JOIN orders o ON o.id = g.order_id
        WHERE ${PUBLIC} AND (g.runner_user_id = $1 OR (o.buyer_user_id = $1 AND g.transferred_from_id IS NULL))
        ORDER BY e.event_date DESC, ra.sort_order`,
      [userId],
    );
    return { items: rows.map(runnerResult) };
  }
}
