-- A registration can have one refund in progress at a time.
CREATE UNIQUE INDEX uq_refunds_open_registration ON refunds(registration_id)
  WHERE registration_id IS NOT NULL AND status IN ('requested', 'approved', 'processing');

-- Why the organiser rejected a request, and the reference of the bank transfer that paid it back.
ALTER TABLE refunds
  ADD COLUMN organizer_note TEXT,
  ADD COLUMN transfer_reference TEXT;
