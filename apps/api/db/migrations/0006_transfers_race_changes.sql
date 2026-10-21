-- Last moment runners may move to another race; NULL = until race day (like transfer_deadline).
ALTER TABLE events ADD COLUMN race_change_deadline TIMESTAMPTZ;

-- The recipient's runner details, kept while they pay the transfer fee. The ID number inside is encrypted
-- the same way as registrations.runner_snapshot.
ALTER TABLE transfers ADD COLUMN runner_payload JSONB;
ALTER TABLE transfers ADD COLUMN cancelled_at TIMESTAMPTZ;
CREATE INDEX idx_transfers_to_email ON transfers(to_email) WHERE status IN ('pending', 'accepted');
CREATE INDEX idx_transfers_fee_order ON transfers(fee_order_id) WHERE fee_order_id IS NOT NULL;

-- The checkout that holds the place in the new race while the runner pays the difference.
ALTER TABLE race_changes ADD COLUMN checkout_session_id UUID REFERENCES checkout_sessions(id);
CREATE INDEX idx_race_changes_order ON race_changes(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_race_changes_open ON race_changes(registration_id) WHERE status = 'pending_payment';
