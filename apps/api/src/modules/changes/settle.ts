import { PoolClient } from 'pg';
import { assignNextBib } from '../bibs/next-bib';
import { queueRaceChangeCompleted, queueTransferCompleted } from '../notifications/emails';
import { writeAudit } from '../org/org-access.service';

/** The recipient's details as checked at acceptance, ready to become their registration. */
export interface TransferRunner {
  snapshot: Record<string, unknown>;
  idDocHash: string;
  age: number;
  answers: Record<string, unknown>;
  firstNameEn: string;
  lastNameEn: string;
  firstNameTh: string | null;
  lastNameTh: string | null;
  gender: string;
  birthDate: string;
  nationality: string;
  email: string | null;
  phone: string | null;
}

/**
 * Runs inside the payment confirmation transaction once an order is paid. A race change or transfer fee order
 * completes its change here; 'refund' means the change can no longer happen (the sender cancelled, the place was
 * used meanwhile) and the money should go back. Never throws for a change that cannot complete, so a payment is
 * always recorded.
 */
export async function settleChangeOrder(client: PoolClient, orderId: string): Promise<'none' | 'done' | 'refund'> {
  const change = await client.query<{ id: string }>('SELECT id FROM race_changes WHERE order_id = $1 FOR UPDATE', [orderId]);
  if (change.rows[0]) return (await completeRaceChange(client, change.rows[0].id)) ? 'done' : 'refund';

  const fee = await client.query(`SELECT 1 FROM order_items WHERE order_id = $1 AND item_type = 'transfer_fee'`, [orderId]);
  if (!fee.rowCount) return 'none';
  const transfer = await client.query<{ id: string }>(
    `SELECT id FROM transfers WHERE fee_order_id = $1 AND status = 'accepted' FOR UPDATE`,
    [orderId],
  );
  if (!transfer.rows[0]) return 'refund';
  return (await completeTransfer(client, transfer.rows[0].id)) ? 'done' : 'refund';
}

/** An unpaid change order ran out of time: the race change lapses, the transfer waits for its recipient again. */
export async function releaseChangeOrder(client: PoolClient, orderId: string): Promise<void> {
  await client.query(`UPDATE race_changes SET status = 'cancelled' WHERE order_id = $1 AND status = 'pending_payment'`, [orderId]);
  await client.query(
    `UPDATE transfers SET status = 'pending', runner_payload = NULL
      WHERE fee_order_id = $1 AND status = 'accepted' AND expires_at > now()`,
    [orderId],
  );
  await client.query(
    `UPDATE transfers SET status = 'expired', runner_payload = NULL WHERE fee_order_id = $1 AND status = 'accepted'`,
    [orderId],
  );
}

/**
 * Hands the place to the recipient: the sender's registration becomes 'transferred' (its QR stops working) and a
 * new confirmed registration takes the same race, shirt, price and bib. Returns false, marking the transfer
 * rejected, if the place is no longer the sender's to give or the recipient already holds a place in the race.
 */
export async function completeTransfer(client: PoolClient, transferId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT t.id, t.status, t.to_user_id, t.runner_payload, t.from_registration_id,
            r.status AS reg_status, r.kit_picked_up_at, r.race_id, r.event_id, r.bib_number, e.organization_id
       FROM transfers t
       JOIN registrations r ON r.id = t.from_registration_id
       JOIN events e ON e.id = r.event_id
      WHERE t.id = $1
      FOR UPDATE OF t, r`,
    [transferId],
  );
  const t = rows[0];
  const reject = async () => {
    await client.query(`UPDATE transfers SET status = 'rejected', runner_payload = NULL WHERE id = $1`, [transferId]);
    return false;
  };
  if (!t || !['pending', 'accepted'].includes(t.status) || !t.runner_payload) return reject();
  if (t.reg_status !== 'confirmed' || t.kit_picked_up_at) return reject();
  const p = t.runner_payload as TransferRunner;

  await client.query('SAVEPOINT transfer_registration');
  let toRegistrationId: string;
  try {
    // The bib moves with the place, so the old row lets go of it first (bibs are unique per event).
    await client.query(`UPDATE registrations SET status = 'transferred', bib_number = NULL, updated_at = now() WHERE id = $1`, [t.from_registration_id]);
    const ageGroup = await client.query<{ id: string }>(
      `SELECT id FROM age_groups WHERE race_id = $1 AND $2 BETWEEN age_min AND age_max
          AND (gender IS NULL OR gender = $3) ORDER BY sort_order LIMIT 1`,
      [t.race_id, p.age, p.gender],
    );
    const regNo = await client.query<{ n: string }>(`SELECT nextval('registration_no_seq') AS n`);
    const created = await client.query<{ id: string }>(
      `INSERT INTO registrations (registration_no, event_id, race_id, order_id, order_item_id, runner_user_id, age_group_id,
                                  status, source, runner_snapshot, first_name_en, last_name_en, first_name_th, last_name_th,
                                  gender, birth_date, age_on_race_day, nationality, id_doc_hash, email, phone,
                                  shirt_variant_id, shirt_size, answers, bib_number, bib_assigned_at, price_paid_satang,
                                  transferred_from_id, confirmed_at)
       SELECT $2, r.event_id, r.race_id, r.order_id, r.order_item_id, $3, $4,
              'confirmed', 'transfer', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              r.shirt_variant_id, r.shirt_size, $17, $18, CASE WHEN $18::text IS NULL THEN NULL ELSE r.bib_assigned_at END, r.price_paid_satang,
              r.id, now()
         FROM registrations r WHERE r.id = $1
       RETURNING id`,
      [
        t.from_registration_id, `R${regNo.rows[0].n}`, t.to_user_id, ageGroup.rows[0]?.id ?? null,
        JSON.stringify(p.snapshot), p.firstNameEn, p.lastNameEn, p.firstNameTh, p.lastNameTh,
        p.gender, p.birthDate, p.age, p.nationality, p.idDocHash, p.email, p.phone,
        JSON.stringify(p.answers), t.bib_number,
      ],
    );
    toRegistrationId = created.rows[0].id;
    await client.query('RELEASE SAVEPOINT transfer_registration');
  } catch (err) {
    // Most likely the recipient registered for this race themselves in the meantime (uq_registrations_person_race).
    await client.query('ROLLBACK TO SAVEPOINT transfer_registration');
    if ((err as { code?: string }).code !== '23505') throw err;
    return reject();
  }

  // The recipient's details now live in their registration; the copy on the transfer is no longer needed.
  await client.query(
    `UPDATE transfers SET status = 'completed', to_registration_id = $2, completed_at = now(), runner_payload = NULL WHERE id = $1`,
    [transferId, toRegistrationId],
  );
  await writeAudit(client, {
    actorId: t.to_user_id, organizationId: t.organization_id, eventId: t.event_id, action: 'transfer.complete',
    entityType: 'registration', entityId: toRegistrationId, after: { from: t.from_registration_id, transferId },
  });
  await queueTransferCompleted(client, transferId);
  return true;
}

/**
 * Moves the runner into the race their change order paid for. The new race's place was already taken as sold by
 * the order's checkout; the old race, its price tier and the old bib are let go, and the runner gets the new race's
 * next bib. Returns false, giving the new place back, if the registration is no longer in the old race.
 */
export async function completeRaceChange(client: PoolClient, raceChangeId: string, actorId?: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT rc.id, rc.status, rc.from_race_id, rc.to_race_id, rc.order_id, rc.requested_by,
            r.id AS registration_id, r.status AS reg_status, r.race_id, r.event_id, r.order_item_id, r.age_on_race_day, r.gender,
            e.organization_id,
            (SELECT price_tier_id FROM order_items WHERE id = r.order_item_id) AS old_tier_id,
            (SELECT id FROM order_items WHERE order_id = rc.order_id AND item_type = 'race' LIMIT 1) AS new_item_id,
            (SELECT price_tier_id FROM order_items WHERE order_id = rc.order_id AND item_type = 'race' LIMIT 1) AS new_tier_id
       FROM race_changes rc
       JOIN registrations r ON r.id = rc.registration_id
       JOIN events e ON e.id = r.event_id
      WHERE rc.id = $1
      FOR UPDATE OF rc, r`,
    [raceChangeId],
  );
  const c = rows[0];
  if (!c || !['pending_payment', 'cancelled'].includes(c.status) || c.reg_status !== 'confirmed' || c.race_id !== c.from_race_id) {
    if (c) {
      await client.query(`UPDATE race_changes SET status = 'rejected' WHERE id = $1`, [raceChangeId]);
      await client.query('UPDATE races SET sold = sold - 1 WHERE id = $1 AND sold > 0', [c.to_race_id]);
      if (c.new_tier_id) await client.query('UPDATE price_tiers SET sold = sold - 1 WHERE id = $1 AND sold > 0', [c.new_tier_id]);
    }
    return false;
  }

  await client.query('UPDATE races SET sold = sold - 1 WHERE id = $1 AND sold > 0', [c.from_race_id]);
  if (c.old_tier_id) await client.query('UPDATE price_tiers SET sold = sold - 1 WHERE id = $1 AND sold > 0', [c.old_tier_id]);
  const ageGroup = await client.query<{ id: string }>(
    `SELECT id FROM age_groups WHERE race_id = $1 AND $2 BETWEEN age_min AND age_max
        AND (gender IS NULL OR gender = $3) ORDER BY sort_order LIMIT 1`,
    [c.to_race_id, c.age_on_race_day, c.gender],
  );
  // The registration now points at the item that bought the new race (and its price tier), so a later refund puts
  // back the right tier. A change made by the organiser has no order; the old tier was let go above either way.
  await client.query(
    `UPDATE registrations SET race_id = $2, order_item_id = $3, age_group_id = $4,
                              bib_number = NULL, bib_assigned_at = NULL, updated_at = now()
      WHERE id = $1`,
    [c.registration_id, c.to_race_id, c.new_item_id, ageGroup.rows[0]?.id ?? null],
  );
  if (c.new_item_id) await client.query('UPDATE order_items SET registration_id = $2 WHERE id = $1', [c.new_item_id, c.registration_id]);
  const bib = await assignNextBib(client, { id: c.registration_id, raceId: c.to_race_id, eventId: c.event_id }, true);
  await client.query(`UPDATE race_changes SET status = 'completed', completed_at = now() WHERE id = $1`, [raceChangeId]);
  await writeAudit(client, {
    actorId: actorId ?? c.requested_by, organizationId: c.organization_id, eventId: c.event_id, action: 'registration.race_change',
    entityType: 'registration', entityId: c.registration_id, after: { fromRaceId: c.from_race_id, toRaceId: c.to_race_id, bib },
  });
  await queueRaceChangeCompleted(client, raceChangeId);
  return true;
}
