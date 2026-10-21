import { Inject, Injectable } from '@nestjs/common';
import { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { decryptPii, encryptPii, hashIdDoc, normaliseIdDoc } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import type { RunnerInput } from '../orders/orders.service';
import { runnerSchema } from '../orders/runner.schema';

export const MAX_PROFILES = 20;

export const profileSchema = runnerSchema.extend({
  nickname: z.string().trim().min(1).max(40).optional(),
  emergencyRelation: z.string().trim().min(1).max(40).optional(),
  shirtSize: z.string().trim().min(1).max(10).optional(),
  clubName: z.string().trim().min(1).max(100).optional(),
  /** The account holder themself; one per account. */
  isSelf: z.boolean().optional(),
});
export type ProfileInput = z.infer<typeof profileSchema>;
/** Everything may change; a missing ID number keeps the one already saved. */
export const profileUpdateSchema = profileSchema.partial();

type Db = Pick<PoolClient, 'query'>;

const COLUMNS = `id, is_self, nickname, first_name_th, last_name_th, first_name_en, last_name_en, gender, birth_date::text AS birth_date,
                 nationality, id_doc_type, id_doc_last4, email, phone, blood_type, emergency_name, emergency_phone,
                 emergency_relation, shirt_size, club_name, updated_at`;

/**
 * Saved runners an account can register again without retyping. The ID number is stored encrypted and never
 * sent back whole: forms show its last four digits and send the profile's id, and the API reads the number itself.
 */
@Injectable()
export class ProfilesService {
  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async list(userId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT ${COLUMNS} FROM runner_profiles WHERE owner_user_id = $1 AND deleted_at IS NULL
        ORDER BY is_self DESC, updated_at DESC`,
      [userId],
    );
    return { items: rows.map(view) };
  }

  async create(userId: string, input: ProfileInput) {
    const count = await this.dbs.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM runner_profiles WHERE owner_user_id = $1 AND deleted_at IS NULL',
      [userId],
    );
    if (count.rows[0].n >= MAX_PROFILES) {
      throw new ProblemException(409, 'TOO_MANY_PROFILES', `An account can keep up to ${MAX_PROFILES} runners`);
    }
    return this.write(async (client) => {
      if (input.isSelf) await client.query('UPDATE runner_profiles SET is_self = false WHERE owner_user_id = $1 AND is_self', [userId]);
      const { rows } = await client.query(
        `INSERT INTO runner_profiles (owner_user_id, is_self, nickname, first_name_th, last_name_th, first_name_en, last_name_en,
                                      gender, birth_date, nationality, id_doc_type, id_doc_number_enc, id_doc_hash, id_doc_last4,
                                      email, phone, blood_type, emergency_name, emergency_phone, emergency_relation, shirt_size, club_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING ${COLUMNS}`,
        [
          userId, input.isSelf ?? false, input.nickname ?? null, input.firstNameTh ?? null, input.lastNameTh ?? null,
          input.firstNameEn.toUpperCase(), input.lastNameEn.toUpperCase(), input.gender, input.birthDate, input.nationality.toUpperCase(),
          input.idDocType, ...this.idDoc(input.idDocNumber), input.email ?? null, input.phone ?? null, input.bloodType ?? 'unknown',
          input.emergencyName, input.emergencyPhone, input.emergencyRelation ?? null, input.shirtSize ?? null, input.clubName ?? null,
        ],
      );
      return view(rows[0]);
    });
  }

  async update(userId: string, profileId: string, patch: z.infer<typeof profileUpdateSchema>) {
    return this.write(async (client) => {
      const current = await client.query('SELECT id FROM runner_profiles WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL FOR UPDATE', [profileId, userId]);
      if (!current.rowCount) throw problems.notFound('Profile');
      if (patch.isSelf) await client.query('UPDATE runner_profiles SET is_self = false WHERE owner_user_id = $1 AND is_self AND id <> $2', [userId, profileId]);
      const sets: string[] = [];
      const params: unknown[] = [profileId];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      const text = (v: string | undefined) => (v === undefined ? undefined : v);
      const fields: [keyof typeof patch, string, (v: never) => unknown][] = [
        ['isSelf', 'is_self', (v: boolean) => v],
        ['nickname', 'nickname', text],
        ['firstNameTh', 'first_name_th', text],
        ['lastNameTh', 'last_name_th', text],
        ['firstNameEn', 'first_name_en', (v: string) => v.toUpperCase()],
        ['lastNameEn', 'last_name_en', (v: string) => v.toUpperCase()],
        ['gender', 'gender', text],
        ['birthDate', 'birth_date', text],
        ['nationality', 'nationality', (v: string) => v.toUpperCase()],
        ['idDocType', 'id_doc_type', text],
        ['email', 'email', text],
        ['phone', 'phone', text],
        ['bloodType', 'blood_type', text],
        ['emergencyName', 'emergency_name', text],
        ['emergencyPhone', 'emergency_phone', text],
        ['emergencyRelation', 'emergency_relation', text],
        ['shirtSize', 'shirt_size', text],
        ['clubName', 'club_name', text],
      ];
      for (const [key, column, map] of fields) if (patch[key] !== undefined) set(column, map(patch[key] as never));
      if (patch.idDocNumber) {
        const [enc, hash, last4] = this.idDoc(patch.idDocNumber);
        set('id_doc_number_enc', enc);
        set('id_doc_hash', hash);
        set('id_doc_last4', last4);
      }
      sets.push('updated_at = now()');
      const { rows } = await client.query(`UPDATE runner_profiles SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, params);
      return view(rows[0]);
    });
  }

  /** Forgets the profile and its ID number for good. Registrations made with it keep their own copy of the runner. */
  async remove(userId: string, profileId: string) {
    const res = await this.dbs.pool.query('DELETE FROM runner_profiles WHERE id = $1 AND owner_user_id = $2', [profileId, userId]);
    if (!res.rowCount) throw problems.notFound('Profile');
    return { id: profileId, deleted: true };
  }

  private idDoc(number: string): [Buffer, string, string] {
    const normalised = normaliseIdDoc(number);
    return [encryptPii(normalised, this.config.PII_ENCRYPTION_KEY), hashIdDoc(normalised, this.config.PII_HASH_KEY), normalised.slice(-4)];
  }

  private async write<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.dbs.transaction((_tx, client) => fn(client));
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_runner_profiles_owner_doc') {
        throw new ProblemException(409, 'PROFILE_EXISTS', 'A runner with this ID card or passport is already saved');
      }
      throw err;
    }
  }
}

/**
 * Completes a runner sent with a saved profile: the profile's ID number (and type) fill in when the form leaves the
 * number out. Returns null when the profile is not one of the user's.
 */
export async function runnerFromProfile(
  db: Db,
  userId: string,
  profileId: string,
  runner: Omit<RunnerInput, 'idDocNumber'> & { idDocNumber?: string },
  piiKey: string,
): Promise<RunnerInput | null> {
  const { rows } = await db.query<{ id_doc_type: RunnerInput['idDocType']; id_doc_number_enc: Buffer }>(
    'SELECT id_doc_type, id_doc_number_enc FROM runner_profiles WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL',
    [profileId, userId],
  );
  const p = rows[0];
  if (!p) return null;
  if (runner.idDocNumber) return { ...runner, idDocNumber: runner.idDocNumber };
  return { ...runner, idDocType: p.id_doc_type, idDocNumber: decryptPii(p.id_doc_number_enc, piiKey) };
}

/**
 * Saves a runner from a registration as one of the user's profiles, or refreshes the profile already saved for the
 * same ID number. Becomes the account's own profile when `isSelf` and there is none yet. Returns the profile id.
 */
export async function saveRunnerProfile(
  client: PoolClient,
  userId: string,
  runner: RunnerInput,
  isSelf: boolean,
  keys: { pii: string; hash: string },
): Promise<string> {
  const normalised = normaliseIdDoc(runner.idDocNumber);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO runner_profiles (owner_user_id, is_self, first_name_th, last_name_th, first_name_en, last_name_en, gender, birth_date,
                                  nationality, id_doc_type, id_doc_number_enc, id_doc_hash, id_doc_last4, email, phone, blood_type,
                                  emergency_name, emergency_phone)
     VALUES ($1, $2 AND NOT EXISTS (SELECT 1 FROM runner_profiles WHERE owner_user_id = $1 AND is_self AND deleted_at IS NULL),
             $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (owner_user_id, id_doc_hash) WHERE deleted_at IS NULL DO UPDATE SET
       first_name_th = EXCLUDED.first_name_th, last_name_th = EXCLUDED.last_name_th, first_name_en = EXCLUDED.first_name_en,
       last_name_en = EXCLUDED.last_name_en, gender = EXCLUDED.gender, birth_date = EXCLUDED.birth_date, nationality = EXCLUDED.nationality,
       id_doc_type = EXCLUDED.id_doc_type, email = COALESCE(EXCLUDED.email, runner_profiles.email), phone = COALESCE(EXCLUDED.phone, runner_profiles.phone),
       blood_type = EXCLUDED.blood_type, emergency_name = EXCLUDED.emergency_name, emergency_phone = EXCLUDED.emergency_phone, updated_at = now()
     RETURNING id`,
    [
      userId, isSelf, runner.firstNameTh ?? null, runner.lastNameTh ?? null, runner.firstNameEn.toUpperCase(), runner.lastNameEn.toUpperCase(),
      runner.gender, runner.birthDate, runner.nationality.toUpperCase(), runner.idDocType, encryptPii(normalised, keys.pii),
      hashIdDoc(normalised, keys.hash), normalised.slice(-4), runner.email ?? null, runner.phone ?? null, runner.bloodType ?? 'unknown',
      runner.emergencyName, runner.emergencyPhone,
    ],
  );
  return rows[0].id;
}

function view(p: Record<string, any>) {
  return {
    id: p.id as string,
    isSelf: p.is_self as boolean,
    nickname: p.nickname as string | null,
    firstNameTh: p.first_name_th as string | null,
    lastNameTh: p.last_name_th as string | null,
    firstNameEn: p.first_name_en as string,
    lastNameEn: p.last_name_en as string,
    gender: p.gender as string,
    birthDate: p.birth_date as string,
    nationality: p.nationality as string,
    idDocType: p.id_doc_type as string,
    idDocLast4: p.id_doc_last4 as string | null,
    email: p.email as string | null,
    phone: p.phone as string | null,
    bloodType: p.blood_type as string,
    emergencyName: p.emergency_name as string | null,
    emergencyPhone: p.emergency_phone as string | null,
    emergencyRelation: p.emergency_relation as string | null,
    shirtSize: p.shirt_size as string | null,
    clubName: p.club_name as string | null,
    updatedAt: p.updated_at as Date,
  };
}
