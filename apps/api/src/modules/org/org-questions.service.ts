import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';

/** File uploads need storage the platform does not have yet, so 'file' questions cannot be created. */
const QUESTION_TYPES = ['text', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const MAX_QUESTIONS_PER_EVENT = 30;
const TEXT_LIMIT: Record<string, number> = { text: 200, textarea: 2000 };

export const questionFieldsSchema = z.object({
  label: z.string().trim().min(1).max(200),
  helpText: z.string().trim().max(300).nullable(),
  type: z.enum(QUESTION_TYPES),
  /** Choices for select / multiselect, in display order. Answers store the chosen text. */
  options: z.array(z.string().trim().min(1).max(100)).max(50).nullable(),
  required: z.boolean(),
  /** Races the question is asked for; null or empty = every race. */
  raceIds: z.array(z.string().uuid()).max(50).nullable(),
  /** Bounds for number questions. */
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
});
export type QuestionFields = z.infer<typeof questionFieldsSchema>;

export const createQuestionSchema = questionFieldsSchema
  .partial()
  .required({ label: true, type: true })
  .transform((q) => ({ helpText: null, options: null, required: false, raceIds: null, min: null, max: null, ...q }));

export const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(MAX_QUESTIONS_PER_EVENT) });

/** A question as the checkout form and the order check see it. */
export interface Question {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  options: string[] | null;
  required: boolean;
  raceIds: string[] | null;
  min: number | null;
  max: number | null;
  isActive: boolean;
}

/** Questions of an event in form order; inactive (removed but already answered) ones only when asked for. */
export async function loadQuestions(db: Pick<PoolClient, 'query'>, eventId: string, includeInactive = false): Promise<Question[]> {
  const { rows } = await db.query(
    `SELECT * FROM form_questions WHERE event_id = $1 ${includeInactive ? '' : 'AND is_active'} ORDER BY is_active DESC, sort_order, created_at`,
    [eventId],
  );
  return rows.map(questionView);
}

/** The runner-facing shape served with the public event page. */
export function publicQuestion(q: Question) {
  return { key: q.key, label: q.label, helpText: q.helpText, type: q.type, options: q.options, required: q.required, raceIds: q.raceIds, min: q.min, max: q.max };
}

const EMPTY = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Checks one runner's answers against the questions asked for their race and returns them cleaned up
 * (trimmed, numbers as numbers, unknown keys dropped). Problems are pushed to `errors` with `pathPrefix`.
 */
export function checkAnswers(
  questions: Question[],
  raceId: string,
  answers: Record<string, unknown> | undefined,
  pathPrefix: string,
  errors: { path: string; message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    if (!q.isActive || (q.raceIds && !q.raceIds.includes(raceId))) continue;
    const path = `${pathPrefix}.${q.key}`;
    const raw = answers?.[q.key];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (EMPTY(value) || (q.type === 'checkbox' && value === false)) {
      if (q.required) errors.push({ path, message: q.type === 'checkbox' ? 'must be ticked' : 'required' });
      else if (q.type === 'checkbox' && value === false) out[q.key] = false;
      continue;
    }
    const bad = (message: string) => errors.push({ path, message });
    switch (q.type) {
      case 'text':
      case 'textarea':
        if (typeof value !== 'string') bad('must be text');
        else if (value.length > TEXT_LIMIT[q.type]) bad(`at most ${TEXT_LIMIT[q.type]} characters`);
        else out[q.key] = value;
        break;
      case 'number': {
        const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replaceAll(',', '')) : NaN;
        if (!Number.isFinite(n)) bad('must be a number');
        else if ((q.min !== null && n < q.min) || (q.max !== null && n > q.max)) bad('out of range');
        else out[q.key] = n;
        break;
      }
      case 'select':
        if (typeof value !== 'string' || !q.options?.includes(value)) bad('not one of the choices');
        else out[q.key] = value;
        break;
      case 'multiselect':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !q.options?.includes(v))) bad('not one of the choices');
        else out[q.key] = [...new Set(value as string[])];
        break;
      case 'checkbox':
        if (value !== true) bad('must be true or false');
        else out[q.key] = true;
        break;
      case 'date':
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) bad('must be a date');
        else out[q.key] = value;
        break;
    }
  }
  return out;
}

@Injectable()
export class OrgQuestionsService {
  constructor(private readonly dbs: DbService) {}

  async list(eventId: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const questions = await loadQuestions(db, eventId);
    const answered = await answerCounts(db, eventId, questions.map((q) => q.key));
    return { items: questions.map((q) => orgView(q, answered.get(q.key) ?? 0)) };
  }

  async create(userId: string, orgId: string, eventId: string, input: z.output<typeof createQuestionSchema>) {
    return this.dbs.transaction(async (_tx, client) => {
      // Serialises question changes per event so the count and sort order stay consistent.
      await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const count = await client.query<{ n: number; next: number }>(
        `SELECT count(*) FILTER (WHERE is_active)::int AS n, COALESCE(max(sort_order) + 1, 0)::int AS next FROM form_questions WHERE event_id = $1`,
        [eventId],
      );
      if (count.rows[0].n >= MAX_QUESTIONS_PER_EVENT) {
        throw new ProblemException(409, 'TOO_MANY_QUESTIONS', `An event can ask at most ${MAX_QUESTIONS_PER_EVENT} questions`);
      }
      const fields = await normalise(client, eventId, input);
      const key = `q_${randomBytes(4).toString('hex')}`;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO form_questions (event_id, key, label_th, help_text, question_type, options, is_required, applies_to_race_ids, validation, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [eventId, key, ...columns(fields), count.rows[0].next],
      );
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'question.create', entityType: 'form_question', entityId: rows[0].id, after: fields });
      return this.list(eventId, client);
    });
  }

  async update(userId: string, orgId: string, eventId: string, questionId: string, patch: Partial<QuestionFields>) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(`SELECT * FROM form_questions WHERE id = $1 AND event_id = $2 AND is_active FOR UPDATE`, [questionId, eventId]);
      if (!rows[0]) throw problems.notFound('Question');
      const current = questionView(rows[0]);
      if (patch.type !== undefined && patch.type !== current.type) {
        const answered = await answerCounts(client, eventId, [current.key]);
        if (answered.get(current.key)) {
          throw new ProblemException(409, 'QUESTION_IN_USE', 'Runners have already answered this question, so its type cannot change');
        }
      }
      const { id: _id, key: _key, isActive: _active, ...before } = current;
      const fields = await normalise(client, eventId, { ...before, ...patch });
      await client.query(
        `UPDATE form_questions SET label_th = $2, help_text = $3, question_type = $4, options = $5, is_required = $6,
                applies_to_race_ids = $7, validation = $8 WHERE id = $1`,
        [questionId, ...columns(fields)],
      );
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'question.update', entityType: 'form_question', entityId: questionId, before, after: patch });
      return this.list(eventId, client);
    });
  }

  /** Answered questions are only switched off, so runners' answers keep their label in the runner detail and export. */
  async remove(userId: string, orgId: string, eventId: string, questionId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query<{ key: string }>(`SELECT key FROM form_questions WHERE id = $1 AND event_id = $2 AND is_active FOR UPDATE`, [questionId, eventId]);
      if (!rows[0]) throw problems.notFound('Question');
      const answered = await answerCounts(client, eventId, [rows[0].key]);
      if (answered.get(rows[0].key)) await client.query('UPDATE form_questions SET is_active = false WHERE id = $1', [questionId]);
      else await client.query('DELETE FROM form_questions WHERE id = $1', [questionId]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'question.delete', entityType: 'form_question', entityId: questionId });
      return this.list(eventId, client);
    });
  }

  async reorder(userId: string, orgId: string, eventId: string, ids: string[]) {
    return this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const { rows } = await client.query<{ id: string }>('SELECT id FROM form_questions WHERE event_id = $1 AND is_active', [eventId]);
      const current = new Set(rows.map((r) => r.id));
      if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some((id) => !current.has(id))) {
        throw problems.validation('List every question of the event exactly once');
      }
      for (const [i, id] of ids.entries()) await client.query('UPDATE form_questions SET sort_order = $2 WHERE id = $1', [id, i]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'question.reorder', entityType: 'event', entityId: eventId, after: { ids } });
      return this.list(eventId, client);
    });
  }
}

/** Checks a question's fields against each other and the event's races. */
async function normalise(client: PoolClient, eventId: string, q: QuestionFields): Promise<QuestionFields> {
  const choice = q.type === 'select' || q.type === 'multiselect';
  const options = choice ? [...new Set(q.options ?? [])] : null;
  if (choice && (options?.length ?? 0) < 2) throw problems.validation('Give at least two choices', [{ path: 'options', message: 'at least two choices' }]);
  const isNumber = q.type === 'number';
  const min = isNumber ? q.min : null;
  const max = isNumber ? q.max : null;
  if (min !== null && max !== null && min > max) throw problems.validation('The minimum must not be above the maximum', [{ path: 'max', message: 'below minimum' }]);
  const raceIds = q.raceIds?.length ? [...new Set(q.raceIds)] : null;
  if (raceIds) {
    const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM races WHERE event_id = $1 AND id = ANY($2) AND is_active', [eventId, raceIds]);
    if (rows[0].n !== raceIds.length) throw problems.validation('Pick races of this event', [{ path: 'raceIds', message: 'unknown race' }]);
  }
  return { label: q.label, helpText: q.helpText, type: q.type, options, required: q.required, raceIds, min, max };
}

function columns(q: QuestionFields) {
  const validation = q.min !== null || q.max !== null ? { min: q.min, max: q.max } : null;
  return [
    q.label, q.helpText, q.type, q.options ? JSON.stringify(q.options.map((o) => ({ value: o, label_th: o }))) : null,
    q.required, q.raceIds, validation ? JSON.stringify(validation) : null,
  ];
}

async function answerCounts(db: Pick<PoolClient, 'query'>, eventId: string, keys: string[]): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const { rows } = await db.query<{ key: string; n: number }>(
    `SELECT k AS key, count(*)::int AS n FROM registrations r, unnest($2::text[]) AS k
      WHERE r.event_id = $1 AND r.answers ? k GROUP BY k`,
    [eventId, keys],
  );
  return new Map(rows.map((r) => [r.key, r.n]));
}

function questionView(r: Record<string, any>): Question {
  const validation = (r.validation ?? {}) as { min?: number | null; max?: number | null };
  return {
    id: r.id,
    key: r.key,
    label: r.label_th,
    helpText: r.help_text,
    type: r.question_type,
    options: r.options ? (r.options as { value: string }[]).map((o) => o.value) : null,
    required: r.is_required,
    raceIds: r.applies_to_race_ids,
    min: validation.min ?? null,
    max: validation.max ?? null,
    isActive: r.is_active,
  };
}

function orgView(q: Question, answered: number) {
  const { isActive: _active, ...rest } = q;
  return { ...rest, answered };
}
