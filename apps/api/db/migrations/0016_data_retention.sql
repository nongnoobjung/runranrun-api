-- Data retention (PDPA): the retention job erases personal data that is no longer needed and records when, so each
-- row is erased once and admins can see what is left to do. See RetentionService for what each erasure keeps.
ALTER TABLE registrations ADD COLUMN pii_erased_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN pii_erased_at TIMESTAMPTZ;
ALTER TABLE transfers ADD COLUMN pii_erased_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN pii_erased_at TIMESTAMPTZ;

CREATE INDEX idx_registrations_pii_kept ON registrations(event_id) WHERE pii_erased_at IS NULL;
CREATE INDEX idx_registrations_unpaid_kept ON registrations(cancelled_at) WHERE pii_erased_at IS NULL AND confirmed_at IS NULL;
CREATE INDEX idx_orders_pii_kept ON orders(event_id) WHERE pii_erased_at IS NULL;
CREATE INDEX idx_users_closed_kept ON users(deleted_at) WHERE status = 'deleted' AND pii_erased_at IS NULL;
