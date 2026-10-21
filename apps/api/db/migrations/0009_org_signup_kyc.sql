-- KYC documents are uploaded by the organiser into private storage. The row keeps the storage key, never a public URL;
-- the file is only served back through authenticated API routes.
ALTER TABLE organizer_kyc_documents RENAME COLUMN file_url TO file_key;
ALTER TABLE organizer_kyc_documents
  ADD COLUMN file_name    TEXT,
  ADD COLUMN content_type TEXT,
  ADD COLUMN size_bytes   INTEGER,
  ADD COLUMN uploaded_by  UUID REFERENCES users(id);

-- The owner submits the payout account; it stays unverified (verified_at NULL) until a platform admin checks it.
-- One submission waits at a time: a new one replaces the previous.
ALTER TABLE bank_accounts
  ADD COLUMN submitted_by UUID REFERENCES users(id),
  ADD COLUMN verified_by  UUID REFERENCES users(id);
CREATE UNIQUE INDEX uq_bank_accounts_unverified ON bank_accounts(organization_id) WHERE verified_at IS NULL;
