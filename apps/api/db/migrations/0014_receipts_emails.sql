-- Receipts and tax invoices. Every paid order gets one document in tax_invoices, numbered per issuer per year with no
-- gaps: the number comes from document_counters in the same transaction that records the payment, so a rollback gives
-- the number back. An organiser with a legal name and tax ID issues its own documents; otherwise the platform does.
-- A buyer who asks for a full tax invoice later gets a new document that replaces the first (status 'replaced').
ALTER TABLE tax_invoices
  ADD COLUMN doc_type        TEXT NOT NULL DEFAULT 'receipt'
                             CHECK (doc_type IN ('receipt', 'abbreviated_tax_invoice', 'tax_invoice')),
  ADD COLUMN doc_year        SMALLINT NOT NULL DEFAULT EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Bangkok'),
  ADD COLUMN doc_seq         INTEGER NOT NULL DEFAULT 0 CHECK (doc_seq >= 0),
  ADD COLUMN issuer_snapshot JSONB NOT NULL DEFAULT '{}';   -- { name, taxId, branch, address, vatRegistered } as at issue
ALTER TABLE tax_invoices ALTER COLUMN doc_year DROP DEFAULT, ALTER COLUMN doc_seq DROP DEFAULT;
-- Each issuer keeps its own running numbers, so the same number may appear under two issuers.
ALTER TABLE tax_invoices DROP CONSTRAINT tax_invoices_invoice_no_key;
CREATE UNIQUE INDEX uq_tax_invoices_issuer_no
  ON tax_invoices ((COALESCE(issuer_org_id, '00000000-0000-0000-0000-000000000000'::uuid)), invoice_no);
-- At most one document in force per order.
CREATE UNIQUE INDEX uq_tax_invoices_order_issued ON tax_invoices(order_id) WHERE status = 'issued';

CREATE TABLE document_counters (
  issuer_key TEXT NOT NULL,                -- organisation id, or 'platform'
  doc_year   SMALLINT NOT NULL,
  last_no    INTEGER NOT NULL CHECK (last_no > 0),
  PRIMARY KEY (issuer_key, doc_year)
);

-- Transactional emails share notifications with broadcasts. A failed send is retried later until it has had five tries.
ALTER TABLE notifications ADD COLUMN next_attempt_at TIMESTAMPTZ;
CREATE INDEX idx_notifications_transactional ON notifications(created_at)
  WHERE status = 'queued' AND broadcast_id IS NULL;
