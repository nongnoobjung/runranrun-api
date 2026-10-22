-- Why a platform admin suspended the account, shown on the admin user page.
ALTER TABLE users ADD COLUMN status_note TEXT;

-- The admin audit log viewer: newest first, filtered by event or by action prefix.
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_event ON audit_logs(event_id, created_at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX idx_audit_action ON audit_logs(action text_pattern_ops);
