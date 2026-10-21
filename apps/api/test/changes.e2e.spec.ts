import { randomUUID } from 'node:crypto';
import { addOrgMember } from '../db/fixtures';
import { HoldReleaseService } from '../src/modules/inventory/hold-release.service';
import { EMAIL_SENDER, FakeEmailSender } from '../src/modules/notifications/email-sender';
import { bootApp, buyer, call, login, raceCounters, runner, seedEvent, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('transfers and race changes', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** The seeded event (21K at ฿1,200 early bird, 10K at ฿900) with transfers and race changes on, and its owner. */
  async function orgEvent(policy: { transferFee?: number; changeFee?: number } = {}) {
    const ev = await seedEvent(ctx.pool, { slug: uniqueSlug(), shirtSizes: [], coupons: [] });
    await ctx.pool.query(
      `UPDATE events SET allow_transfer = true, transfer_fee_satang = $2, allow_race_change = true, race_change_fee_satang = $3 WHERE id = $1`,
      [ev.eventId, policy.transferFee ?? 0, policy.changeFee ?? 0],
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...ev, ownerToken: token, base: `/v1/org/${ev.organizationId}/events/${ev.eventId}` };
  }

  /** Pays an order through the fake gateway, as its buyer. */
  async function pay(token: string, orderId: string) {
    const payment = await call(ctx.app, 'POST', `/v1/orders/${orderId}/payments`, { token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    if (payment.status !== 201) throw new Error(JSON.stringify(payment.body));
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    return sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
  }

  /** A paid place in `code` for a new runner who registered themselves. */
  async function paidPlace(ev: Awaited<ReturnType<typeof orgEvent>>, code: '21K' | '10K') {
    const { token, userId } = await login(ctx.app);
    const raceId = ev.raceIds[code];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, isSelf: true, runner: runner() }] },
    });
    await pay(token, order.body.id);
    const reg = await ctx.pool.query('SELECT id, bib_number FROM registrations WHERE order_id = $1', [order.body.id]);
    return { token, userId, registrationId: reg.rows[0].id as string, bib: reg.rows[0].bib_number as string, orderId: order.body.id as string };
  }

  const myRegistrations = async (token: string) => (await call(ctx.app, 'GET', '/v1/me/registrations', { token })).body.items as { id: string }[];

  it('hands a place to the recipient with their own details, keeping the bib', async () => {
    const ev = await orgEvent();
    const sender = await paidPlace(ev, '10K');
    const recipientEmail = `friend-${randomUUID()}@example.com`;
    const outbox = ctx.app.get<FakeEmailSender>(EMAIL_SENDER).outbox;

    expect((await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: 'not-an-email' } })).status).toBe(422);
    const created = await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: recipientEmail.toUpperCase() } });
    expect(created.status).toBe(201);
    expect(created.body.transfer.open).toMatchObject({ status: 'pending', toEmail: recipientEmail, feeSatang: 0 });
    expect(created.body.raceChange.reason).toBe('TRANSFER_IN_PROGRESS');
    expect(outbox.at(-1)).toMatchObject({ to: recipientEmail, text: expect.stringContaining('/me/transfers') });
    const again = await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: 'other@example.com' } });
    expect(again.body.code).toBe('TRANSFER_IN_PROGRESS');
    // A refund cannot be asked for while the place is on offer.
    expect((await call(ctx.app, 'GET', `/v1/me/registrations/${sender.registrationId}/refund`, { token: sender.token })).body.reason).toBe('TRANSFER_IN_PROGRESS');

    const recipient = await login(ctx.app, recipientEmail);
    const incoming = (await call(ctx.app, 'GET', '/v1/me/transfers', { token: recipient.token })).body.incoming;
    expect(incoming).toEqual([expect.objectContaining({ status: 'pending', race: expect.objectContaining({ code: '10K' }), feeSatang: 0 })]);
    expect(incoming[0].runner).toBeUndefined();

    const transferId = incoming[0].id;
    const stranger = await login(ctx.app);
    expect((await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, { token: stranger.token, body: { runner: runner() } })).status).toBe(404);

    const accepted = await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, {
      token: recipient.token,
      body: { runner: runner({ firstNameEn: 'Mali', lastNameEn: 'Suksai', firstNameTh: 'มะลิ', lastNameTh: 'สุขใส', gender: 'female' }) },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('completed');

    const regs = await ctx.pool.query('SELECT id, status, bib_number, runner_user_id, first_name_en, source, transferred_from_id FROM registrations WHERE id = ANY($1)', [
      [sender.registrationId, accepted.body.registrationId],
    ]);
    const before = regs.rows.find((r) => r.id === sender.registrationId);
    const after = regs.rows.find((r) => r.id === accepted.body.registrationId);
    expect(before).toMatchObject({ status: 'transferred', bib_number: null });
    expect(after).toMatchObject({ status: 'confirmed', bib_number: sender.bib, runner_user_id: recipient.userId, first_name_en: 'MALI', source: 'transfer', transferred_from_id: sender.registrationId });
    expect(await myRegistrations(sender.token)).toEqual([]);
    expect((await myRegistrations(recipient.token)).map((r) => r.id)).toEqual([accepted.body.registrationId]);
    expect((await raceCounters(ctx.pool, ev.raceIds['10K'])).sold).toBe(1);

    const list = await call(ctx.app, 'GET', `${ev.base}/changes`, { token: ev.ownerToken });
    expect(list.body.transfers).toEqual([
      expect.objectContaining({ status: 'completed', bibNumber: sender.bib, to: expect.objectContaining({ email: recipientEmail, name: 'มะลิ สุขใส' }) }),
    ]);
  });

  it('checks the policy, the sender and the recipient', async () => {
    const ev = await orgEvent();
    const sender = await paidPlace(ev, '21K');
    const me = await ctx.pool.query('SELECT email FROM users WHERE id = $1', [sender.userId]);
    const self = await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: me.rows[0].email } });
    expect(self.body.code).toBe('SELF_TRANSFER');

    const email = `kid-${randomUUID()}@example.com`;
    await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: email } });
    const kid = await login(ctx.app, email);
    const transferId = (await call(ctx.app, 'GET', '/v1/me/transfers', { token: kid.token })).body.incoming[0].id;
    // The 21K needs runners aged 16 on race day.
    const young = await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, { token: kid.token, body: { runner: runner({ birthDate: '2015-01-01' }) } });
    expect(young.status).toBe(422);
    expect(young.body.errors).toEqual([expect.objectContaining({ path: 'runner.birthDate' })]);

    expect((await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/decline`, { token: kid.token })).body.status).toBe('rejected');
    expect((await call(ctx.app, 'GET', `/v1/me/registrations/${sender.registrationId}/changes`, { token: sender.token })).body.transfer).toMatchObject({ allowed: true, open: null });

    await ctx.pool.query('UPDATE events SET allow_transfer = false WHERE id = $1', [ev.eventId]);
    const off = await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: email } });
    expect(off.body.code).toBe('TRANSFER_NOT_ALLOWED');
  });

  it('moves the place only once the recipient pays the fee, and refunds a fee paid after the sender cancelled', async () => {
    const ev = await orgEvent({ transferFee: 10_000 });
    const sender = await paidPlace(ev, '10K');
    const email = `payer-${randomUUID()}@example.com`;
    await call(ctx.app, 'POST', `/v1/me/registrations/${sender.registrationId}/transfers`, { token: sender.token, body: { toEmail: email } });
    const recipient = await login(ctx.app, email);
    const transferId = (await call(ctx.app, 'GET', '/v1/me/transfers', { token: recipient.token })).body.incoming[0].id;

    const accepted = await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, { token: recipient.token, body: { runner: runner() } });
    expect(accepted.body.status).toBe('pending_payment');
    const order = await call(ctx.app, 'GET', `/v1/orders/${accepted.body.orderId}`, { token: recipient.token });
    // ฿100 fee plus the 2% payment fee used in tests.
    expect(order.body).toMatchObject({ totalSatang: 10_200, purpose: { kind: 'transfer', status: 'accepted' }, registrations: [] });
    expect((await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, { token: recipient.token, body: { runner: runner() } })).body.orderId).toBe(accepted.body.orderId);

    // Running out of time sends the transfer back to waiting for the recipient.
    await ctx.pool.query(`UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = (SELECT checkout_session_id FROM orders WHERE id = $1)`, [accepted.body.orderId]);
    await ctx.app.get(HoldReleaseService).releaseExpired();
    expect((await ctx.pool.query('SELECT status, runner_payload FROM transfers WHERE id = $1', [transferId])).rows[0]).toEqual({ status: 'pending', runner_payload: null });

    const second = await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, { token: recipient.token, body: { runner: runner() } });
    await pay(recipient.token, second.body.orderId);
    const done = await ctx.pool.query('SELECT status, to_registration_id FROM transfers WHERE id = $1', [transferId]);
    expect(done.rows[0].status).toBe('completed');
    expect((await myRegistrations(recipient.token)).map((r) => r.id)).toEqual([done.rows[0].to_registration_id]);

    // Second case: the sender calls it off while the recipient's QR is still open, and the money arrives anyway.
    const other = await paidPlace(ev, '10K');
    const email2 = `late-${randomUUID()}@example.com`;
    await call(ctx.app, 'POST', `/v1/me/registrations/${other.registrationId}/transfers`, { token: other.token, body: { toEmail: email2 } });
    const late = await login(ctx.app, email2);
    const lateId = (await call(ctx.app, 'GET', '/v1/me/transfers', { token: late.token })).body.incoming[0].id;
    const lateAccept = await call(ctx.app, 'POST', `/v1/me/transfers/${lateId}/accept`, { token: late.token, body: { runner: runner() } });
    const payment = await call(ctx.app, 'POST', `/v1/orders/${lateAccept.body.orderId}/payments`, { token: late.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    expect((await call(ctx.app, 'DELETE', `/v1/me/transfers/${lateId}`, { token: other.token })).body.status).toBe('cancelled');
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    expect((await ctx.pool.query('SELECT status FROM registrations WHERE id = $1', [other.registrationId])).rows[0].status).toBe('confirmed');
    const refund = await ctx.pool.query('SELECT status, amount_satang, reason FROM refunds WHERE order_id = $1', [lateAccept.body.orderId]);
    expect(refund.rows).toEqual([{ status: 'approved', amount_satang: '10200', reason: 'change_not_possible' }]);
  });

  it('moves up a race after the difference and fee are paid, with a bib from the new range', async () => {
    const ev = await orgEvent({ changeFee: 5_000 });
    const place = await paidPlace(ev, '10K');
    expect(place.bib).toBe('2001');

    const options = await call(ctx.app, 'GET', `/v1/me/registrations/${place.registrationId}/changes`, { token: place.token });
    expect(options.body.raceChange).toMatchObject({ allowed: true, feeSatang: 5_000 });
    expect(options.body.raceChange.options).toEqual([
      expect.objectContaining({ code: '21K', priceSatang: 120_000, priceDiffSatang: 30_000, dueSatang: 35_000, available: true }),
    ]);

    const started = await call(ctx.app, 'POST', `/v1/me/registrations/${place.registrationId}/race-changes`, { token: place.token, body: { toRaceId: ev.raceIds['21K'] } });
    expect(started.body.status).toBe('pending_payment');
    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toMatchObject({ reserved: 1, sold: 0 });
    const again = await call(ctx.app, 'POST', `/v1/me/registrations/${place.registrationId}/race-changes`, { token: place.token, body: { toRaceId: ev.raceIds['21K'] } });
    expect(again.body).toMatchObject({ code: 'RACE_CHANGE_IN_PROGRESS', orderId: started.body.orderId });
    const order = await call(ctx.app, 'GET', `/v1/orders/${started.body.orderId}`, { token: place.token });
    expect(order.body).toMatchObject({ subtotalSatang: 35_000, totalSatang: 35_700, purpose: { kind: 'race_change', raceCode: '21K', status: 'pending_payment' } });

    await pay(place.token, started.body.orderId);
    const reg = await ctx.pool.query('SELECT race_id, bib_number, status FROM registrations WHERE id = $1', [place.registrationId]);
    expect(reg.rows[0]).toEqual({ race_id: ev.raceIds['21K'], bib_number: '0001', status: 'confirmed' });
    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toMatchObject({ reserved: 0, sold: 1 });
    expect(await raceCounters(ctx.pool, ev.raceIds['10K'])).toMatchObject({ reserved: 0, sold: 0 });
    const tiers = await ctx.pool.query('SELECT name, sold FROM price_tiers WHERE race_id = $1 ORDER BY starts_at, price_satang', [ev.raceIds['21K']]);
    expect(tiers.rows[0]).toEqual({ name: 'Early bird', sold: 1 });
    expect((await call(ctx.app, 'GET', `/v1/orders/${started.body.orderId}`, { token: place.token })).body.purpose).toMatchObject({ status: 'completed', registrationId: place.registrationId });
  });

  it('moves down at once with nothing to pay, lets a lapsed hold go, and lets the organiser move runners', async () => {
    const ev = await orgEvent();
    const place = await paidPlace(ev, '21K');

    const down = await call(ctx.app, 'POST', `/v1/me/registrations/${place.registrationId}/race-changes`, { token: place.token, body: { toRaceId: ev.raceIds['10K'] } });
    expect(down.body.status).toBe('completed');
    expect((await ctx.pool.query('SELECT bib_number FROM registrations WHERE id = $1', [place.registrationId])).rows[0].bib_number).toBe('2001');
    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toMatchObject({ sold: 0, reserved: 0 });

    // Back up to the 21K (the place was paid at the 21K price, so only a fee is due), but the hold runs out before paying.
    await ctx.pool.query('UPDATE events SET race_change_fee_satang = 2000 WHERE id = $1', [ev.eventId]);
    const up = await call(ctx.app, 'POST', `/v1/me/registrations/${place.registrationId}/race-changes`, { token: place.token, body: { toRaceId: ev.raceIds['21K'] } });
    expect(up.body.status).toBe('pending_payment');
    await ctx.pool.query(`UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = (SELECT checkout_session_id FROM orders WHERE id = $1)`, [up.body.orderId]);
    await ctx.app.get(HoldReleaseService).releaseExpired();
    expect((await ctx.pool.query('SELECT status FROM race_changes WHERE id = $1', [up.body.raceChangeId])).rows[0].status).toBe('cancelled');
    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toMatchObject({ sold: 0, reserved: 0 });

    // A second try can be called off by the runner.
    const retry = await call(ctx.app, 'POST', `/v1/me/registrations/${place.registrationId}/race-changes`, { token: place.token, body: { toRaceId: ev.raceIds['21K'] } });
    expect((await call(ctx.app, 'DELETE', `/v1/me/race-changes/${retry.body.raceChangeId}`, { token: place.token })).body.status).toBe('cancelled');
    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toMatchObject({ sold: 0, reserved: 0 });

    // The organiser moves the runner back without payment, even after the runner's own deadline.
    await ctx.pool.query(`UPDATE events SET race_change_deadline = now() - interval '1 day' WHERE id = $1`, [ev.eventId]);
    expect((await call(ctx.app, 'GET', `/v1/me/registrations/${place.registrationId}/changes`, { token: place.token })).body.raceChange.reason).toBe('RACE_CHANGE_CLOSED');
    const staffEmail = `staff-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, staffEmail, 'staff');
    const staff = await login(ctx.app, staffEmail);
    const url = `${ev.base}/registrations/${place.registrationId}/race-change`;
    expect((await call(ctx.app, 'POST', url, { token: staff.token, body: { toRaceId: ev.raceIds['21K'] } })).status).toBe(403);
    const moved = await call(ctx.app, 'POST', url, { token: ev.ownerToken, body: { toRaceId: ev.raceIds['21K'] } });
    expect(moved.status).toBe(200);
    // Bib numbers are not handed out twice, so the runner's old 21K number 0001 stays unused.
    expect((await ctx.pool.query('SELECT race_id, bib_number FROM registrations WHERE id = $1', [place.registrationId])).rows[0]).toEqual({ race_id: ev.raceIds['21K'], bib_number: '0002' });
    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toMatchObject({ sold: 1, reserved: 0 });
    expect(await raceCounters(ctx.pool, ev.raceIds['10K'])).toMatchObject({ sold: 0 });

    const list = await call(ctx.app, 'GET', `${ev.base}/changes`, { token: ev.ownerToken });
    expect(list.body.raceChanges.map((c: { status: string; byOrganizer: boolean }) => [c.status, c.byOrganizer])).toEqual([
      ['completed', true], ['cancelled', false], ['cancelled', false], ['completed', false],
    ]);
  });
});
