-- Whether an organisation's events wait for a platform admin before going live the first time.
-- New organisations are reviewed; the ones already here keep publishing on their own, as before.
ALTER TABLE organizations ADD COLUMN review_events BOOLEAN NOT NULL DEFAULT true;
UPDATE organizations SET review_events = false;

-- Why the organisation was suspended or its KYC was sent back, shown to its owners.
ALTER TABLE organizations ADD COLUMN status_note TEXT;

CREATE INDEX idx_events_pending_review ON events(submitted_at) WHERE status = 'pending_review';
CREATE INDEX idx_settlements_event ON settlements(event_id, created_at DESC);
