import { randomUUID } from 'node:crypto';
import { setPlatformRole } from '../db/fixtures';
import { FILE_STORAGE, FileStorage } from '../src/common/storage';
import { AppConfig, CONFIG } from '../src/config';
import { DbService } from '../src/db/db.service';
import { RetentionService } from '../src/modules/retention/retention.service';
import { bootApp, buyer, call, login, runner, seedEvent, sendFakeWebhook, TestContext } from './helpers';

describe('data retention', () => {
  let ctx: TestContext;
  let storage: FileStorage;
  let admin: string;

  beforeAll(async () => {
    ctx = await bootApp();
    storage = ctx.app.get(FILE_STORAGE);
    const email = `retention-admin-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, email, 'admin');
    admin = (await login(ctx.app, email)).token;
  });
  afterAll(() => ctx.close());

  const days = (n: number) => `now() - interval '${n} days'`;

  /** A runner who paid for a 10K place, ran (bib, kit pickup by a proxy, a published result) on an event `ago` days back. */
  async function ranDaysAgo(ago: number) {
    const me = await login(ctx.app);
    const ev = await seedEvent(ctx.pool, { shirtSizes: [], coupons: [] });
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: me.token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        checkoutSessionId: session.body.id,
        buyer,
        participants: [{ raceId, isSelf: true, runner: runner({ email: 'runner@example.com', phone: '0812345678', bloodType: 'O' }) }],
        consents: { terms: true, privacy: true, shareWithOrganizer: true },
      },
    });
    expect(order.status).toBe(201);
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token: me.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);

    const reg = (await ctx.pool.query(`SELECT id, bib_number FROM registrations WHERE order_id = $1 AND status = 'confirmed'`, [order.body.id])).rows[0];
    await ctx.pool.query(`UPDATE registrations SET answers = '{"club":"Riverside Runners","medical":"asthma"}' WHERE id = $1`, [reg.id]);
    await ctx.pool.query(
      `INSERT INTO checkins (registration_id, picked_up_by, proxy_doc_note, shirt_size_given, client_uuid, scanned_at)
       VALUES ($1, 'สมหญิง ใจดี', 'บัตรประชาชน 3100500012345', 'M', $2, now())`,
      [reg.id, randomUUID()],
    );
    await ctx.pool.query(
      `INSERT INTO results (event_id, race_id, registration_id, bib_number, display_name, gender, age_group_code, status, chip_time_ms, is_published)
       VALUES ($1, $2, $3, $4, 'SOMCHAI JAIDEE', 'male', 'M30', 'FIN', 3000000, true)`,
      [ev.eventId, raceId, reg.id, reg.bib_number],
    );
    await ctx.pool.query(`UPDATE events SET event_date = current_date - $2::int, results_published_at = now() WHERE id = $1`, [ev.eventId, ago]);
    return { ...me, eventId: ev.eventId, orderId: order.body.id as string, registrationId: reg.id as string, bib: reg.bib_number as string };
  }

  /** An order that was never paid and lapsed `ago` days back (the hold release job cancels its registration). */
  async function lapsedDaysAgo(ago: number) {
    const me = await login(ctx.app);
    const ev = await seedEvent(ctx.pool, { shirtSizes: [], coupons: [] });
    const raceId = ev.raceIds['21K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: me.token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: runner() }] },
    });
    await ctx.pool.query(`UPDATE orders SET status = 'expired', expires_at = ${days(ago)} WHERE id = $1`, [order.body.id]);
    await ctx.pool.query(`UPDATE registrations SET status = 'cancelled', cancelled_at = ${days(ago)}, cancel_reason = 'order_expired' WHERE order_id = $1`, [order.body.id]);
    return { orderId: order.body.id as string };
  }

  /** A KYC file on disk with its row; returns the row id and the storage key. */
  async function kycDocument(orgId: string, status: 'pending' | 'approved' | 'rejected', ago: number) {
    const id = randomUUID();
    const key = `kyc/${orgId}/${id}.pdf`;
    await storage.put(key, Buffer.from('%PDF-1.4 test'), 'application/pdf');
    await ctx.pool.query(
      `INSERT INTO organizer_kyc_documents (id, organization_id, doc_type, file_key, file_name, content_type, size_bytes, status, reviewed_at, created_at)
       VALUES ($1, $2, 'id_card', $3, 'id.pdf', 'application/pdf', 13, $4::kyc_status, CASE WHEN $4::kyc_status = 'pending' THEN NULL ELSE ${days(ago)} END, ${days(ago)})`,
      [id, orgId, key, status],
    );
    return { id, key };
  }

  async function organization(status: 'pending_kyc' | 'active', ago: number) {
    const { rows } = await ctx.pool.query(
      `INSERT INTO organizations (slug, name_th, status, updated_at) VALUES ($1, 'ทีมทดสอบ retention', $2, ${days(ago)}) RETURNING id`,
      [`retention-${randomUUID().slice(0, 8)}`, status],
    );
    return rows[0].id as string;
  }

  const registration = async (id: string) =>
    (await ctx.pool.query(
      `SELECT first_name_en, last_name_en, first_name_th, gender, birth_date::text AS birth_date, age_on_race_day, age_group_id, bib_number,
              status, price_paid_satang, shirt_size, kit_picked_up_at, email, phone, answers, id_doc_hash, runner_snapshot, pii_erased_at
         FROM registrations WHERE id = $1`,
      [id],
    )).rows[0];
  const order = async (id: string) =>
    (await ctx.pool.query('SELECT buyer_name, buyer_email, buyer_phone, total_satang, paid_at, pii_erased_at FROM orders WHERE id = $1', [id])).rows[0];

  it('lets only platform admins see the report and run it', async () => {
    const support = `retention-support-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, support, 'support');
    const supportToken = (await login(ctx.app, support)).token;
    const runnerToken = (await login(ctx.app)).token;
    for (const token of [supportToken, runnerToken]) {
      expect((await call(ctx.app, 'GET', '/v1/admin/retention', { token })).status).toBe(403);
      expect((await call(ctx.app, 'POST', '/v1/admin/retention/run', { token })).status).toBe(403);
    }
    expect((await call(ctx.app, 'GET', '/v1/admin/retention')).status).toBe(401);
    const me = await call(ctx.app, 'GET', '/v1/admin/me', { token: admin });
    expect(me.body.can.retention).toBe(true);
  });

  it('erases what is past its period, keeps results, kit history, accounting and evidence, and reports it first', async () => {
    const old = await ranDaysAgo(400);
    const recent = await ranDaysAgo(100);
    const lapsed = await lapsedDaysAgo(40);
    const lapsedRecently = await lapsedDaysAgo(5);

    // Closed accounts: one past the grace period (its registration goes even though the event was only 100 days ago).
    const leaving = await ranDaysAgo(100);
    const stillGrace = await ranDaysAgo(100);
    for (const who of [leaving, stillGrace]) {
      expect((await call(ctx.app, 'DELETE', '/v1/me', { token: who.token, body: { confirm: true } })).status).toBe(200);
      await ctx.pool.query(
        `INSERT INTO notifications (user_id, channel, template_key, recipient, payload) VALUES ($1, 'email', 'order_confirmed', 'runner@example.com', '{}')`,
        [who.userId],
      );
    }
    await ctx.pool.query(`UPDATE users SET deleted_at = ${days(40)} WHERE id = $1`, [leaving.userId]);
    await ctx.pool.query(`UPDATE users SET deleted_at = ${days(5)} WHERE id = $1`, [stillGrace.userId]);

    // A transfer the recipient never took up, 40 days ago: their email and details go; the place stays with the sender.
    const offered = await ctx.pool.query(
      `INSERT INTO transfers (from_registration_id, from_user_id, to_email, accept_token_hash, status, expires_at, runner_payload)
       VALUES ($1, $2, 'friend@example.com', $3, 'expired', ${days(40)}, '{"firstNameEn":"Friend"}') RETURNING id`,
      [recent.registrationId, recent.userId, randomUUID()],
    );

    const stalledOrg = await organization('pending_kyc', 200);
    const stalled = await kycDocument(stalledOrg, 'pending', 200);
    const activeOrg = await organization('active', 400);
    const rejectedLongAgo = await kycDocument(activeOrg, 'rejected', 200);
    const rejectedRecently = await kycDocument(activeOrg, 'rejected', 10);
    const approved = await kycDocument(activeOrg, 'approved', 400);

    await ctx.pool.query(`INSERT INTO otp_codes (target, code_hash, purpose, expires_at) VALUES ('runner@example.com', 'x', 'login', ${days(40)})`);
    await ctx.pool.query(`INSERT INTO otp_codes (target, code_hash, purpose, expires_at) VALUES ('runner@example.com', 'y', 'login', now() + interval '5 minutes')`);

    const evidence = async () =>
      (await ctx.pool.query(`SELECT (SELECT count(*) FROM consents)::int AS consents, (SELECT count(*) FROM audit_logs)::int AS audit`)).rows[0];
    const before = await evidence();

    // The dry run counts what is due and changes nothing.
    const report = await call(ctx.app, 'GET', '/v1/admin/retention', { token: admin });
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      dryRun: true,
      periods: { registrationDays: 365, unpaidDays: 30, closedAccountDays: 30, kycDays: 180 },
      schedule: '30 3 * * *',
      kept: { consents: { count: before.consents }, auditLogs: { count: before.audit } },
    });
    expect(report.body.due).toEqual({
      registrations: expect.any(Number), orders: expect.any(Number), transfers: expect.any(Number),
      closedAccounts: expect.any(Number), kycDocuments: expect.any(Number), expiredCodes: expect.any(Number),
    });
    // old + leaving + the lapsed order's registration; old + leaving + the lapsed order; the transfer; leaving; stalled + rejectedLongAgo; one OTP.
    expect(report.body.due.registrations).toBeGreaterThanOrEqual(3);
    expect(report.body.due.orders).toBeGreaterThanOrEqual(3);
    expect(report.body.due.transfers).toBeGreaterThanOrEqual(1);
    expect(report.body.due.closedAccounts).toBeGreaterThanOrEqual(1);
    expect(report.body.due.kycDocuments).toBeGreaterThanOrEqual(2);
    expect(report.body.due.expiredCodes).toBeGreaterThanOrEqual(1);
    expect((await registration(old.registrationId)).pii_erased_at).toBeNull();
    expect(await storage.get(stalled.key)).not.toBeNull();

    const run = await call(ctx.app, 'POST', '/v1/admin/retention/run', { token: admin });
    expect(run.status).toBe(200);
    expect(run.body.counts).toEqual(report.body.due);

    // Past the period: only what results, kit history and accounting need is left.
    const erased = await registration(old.registrationId);
    expect(erased).toMatchObject({
      first_name_en: 'SOMCHAI', last_name_en: 'JAIDEE', first_name_th: 'สมชาย', gender: 'male', bib_number: old.bib, status: 'confirmed',
      birth_date: '1990-01-01', email: null, phone: null, answers: {}, id_doc_hash: `erased:${old.registrationId}`,
    });
    expect(erased.age_on_race_day).toBeGreaterThan(30);
    expect(Number(erased.price_paid_satang)).toBe(90_000);
    expect(Object.keys(erased.runner_snapshot).sort()).toEqual(['erasedAt', 'firstNameEn', 'firstNameTh', 'gender', 'idDocType', 'lastNameEn', 'lastNameTh', 'nationality']);
    expect(JSON.stringify(erased.runner_snapshot)).not.toMatch(/สมหญิง|081|O"|idDoc(Number|Last4)/);
    expect(await order(old.orderId)).toMatchObject({ buyer_name: buyer.name, buyer_email: null, buyer_phone: null, paid_at: expect.any(Date) });
    expect(Number((await order(old.orderId)).total_satang)).toBeGreaterThan(0);
    const checkin = await ctx.pool.query('SELECT picked_up_by, proxy_doc_note, shirt_size_given FROM checkins WHERE registration_id = $1', [old.registrationId]);
    expect(checkin.rows[0]).toEqual({ picked_up_by: 'สมหญิง ใจดี', proxy_doc_note: null, shirt_size_given: 'M' });
    const result = await ctx.pool.query('SELECT display_name, bib_number, is_published FROM results WHERE registration_id = $1', [old.registrationId]);
    expect(result.rows[0]).toEqual({ display_name: 'SOMCHAI JAIDEE', bib_number: old.bib, is_published: true });
    const searched = await call(ctx.app, 'GET', `/v1/results/search?q=${old.bib}`);
    expect(JSON.stringify(searched.body)).toContain('SOMCHAI JAIDEE');

    // Within the period: untouched.
    const kept = await registration(recent.registrationId);
    expect(kept).toMatchObject({ email: 'runner@example.com', birth_date: '1990-03-12', answers: { club: 'Riverside Runners' }, pii_erased_at: null });
    expect(kept.runner_snapshot.idDocNumberEnc).toEqual(expect.any(String));
    expect((await order(recent.orderId)).buyer_email).toBe(buyer.email);

    // Unpaid orders past M days lose everything typed into them; recent ones stay so the buyer can still look.
    expect(await order(lapsed.orderId)).toMatchObject({ buyer_name: null, buyer_email: null, buyer_phone: null, pii_erased_at: expect.any(Date) });
    const unpaidReg = (await ctx.pool.query('SELECT id FROM registrations WHERE order_id = $1', [lapsed.orderId])).rows[0];
    expect(await registration(unpaidReg.id)).toMatchObject({ first_name_en: '', last_name_en: '', first_name_th: null, email: null });
    expect(Object.keys((await registration(unpaidReg.id)).runner_snapshot)).toEqual(['erasedAt']);
    expect((await order(lapsedRecently.orderId)).buyer_email).toBe(buyer.email);

    const transfer = await ctx.pool.query('SELECT to_email, runner_payload FROM transfers WHERE id = $1', [offered.rows[0].id]);
    expect(transfer.rows[0]).toEqual({ to_email: `erased-${offered.rows[0].id}@erased.invalid`, runner_payload: null });

    // Closed accounts past K days: sign-ins and messages go, registrations are erased without waiting for the event period.
    const gone = await ctx.pool.query('SELECT pii_erased_at FROM users WHERE id = $1', [leaving.userId]);
    expect(gone.rows[0].pii_erased_at).toEqual(expect.any(Date));
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [leaving.userId])).rows[0].n).toBe(0);
    expect((await registration(leaving.registrationId)).email).toBeNull();
    expect((await order(leaving.orderId)).buyer_email).toBeNull();
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [stillGrace.userId])).rows[0].n).toBe(1);
    expect((await registration(stillGrace.registrationId)).email).toBe('runner@example.com');

    // KYC files: rejected long ago and a stalled sign-up go (file and row, with an audit entry); the rest stay.
    for (const doc of [stalled, rejectedLongAgo]) {
      expect(await storage.get(doc.key)).toBeNull();
      expect((await ctx.pool.query('SELECT 1 FROM organizer_kyc_documents WHERE id = $1', [doc.id])).rowCount).toBe(0);
      const audit = await ctx.pool.query(`SELECT actor_type FROM audit_logs WHERE action = 'retention.kyc_document_delete' AND entity_id = $1`, [doc.id]);
      expect(audit.rows).toEqual([{ actor_type: 'admin' }]);
    }
    for (const doc of [rejectedRecently, approved]) expect(await storage.get(doc.key)).not.toBeNull();

    // Consents and audit logs are evidence: nothing was removed (the run only added its own entries).
    const after = await evidence();
    expect(after.consents).toBe(before.consents);
    expect(after.audit).toBeGreaterThan(before.audit);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM consents WHERE registration_id = $1', [old.registrationId])).rows[0].n).toBe(1);

    // The report shows the run and nothing more to do.
    const afterReport = await call(ctx.app, 'GET', '/v1/admin/retention', { token: admin });
    expect(afterReport.body.lastRun).toMatchObject({ counts: run.body.counts, byUserId: expect.any(String) });
    expect(afterReport.body.due).toEqual({ registrations: 0, orders: 0, transfers: 0, closedAccounts: 0, kycDocuments: 0, expiredCodes: 0 });
  });

  it('changes nothing when run again, and works through more rows than one batch', async () => {
    const service = ctx.app.get(RetentionService);
    const runners = [await ranDaysAgo(500), await ranDaysAgo(500), await ranDaysAgo(500)];
    const small = new RetentionService(ctx.app.get(DbService), { ...ctx.app.get<AppConfig>(CONFIG), RETENTION_BATCH_SIZE: 2 }, storage);
    const first = await small.run();
    expect(first.registrations).toBe(3);
    expect(first.orders).toBe(3);
    for (const r of runners) expect((await registration(r.registrationId)).pii_erased_at).toEqual(expect.any(Date));
    const snapshot = await registration(runners[0].registrationId);

    const again = await service.run();
    expect(again).toEqual({ registrations: 0, orders: 0, transfers: 0, closedAccounts: 0, kycDocuments: 0, expiredCodes: 0 });
    expect(await registration(runners[0].registrationId)).toEqual(snapshot);
    const last = await call(ctx.app, 'GET', '/v1/admin/retention', { token: admin });
    expect(last.body.lastRun).toMatchObject({ byUserId: null, counts: again });
  });
});
