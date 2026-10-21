-- One open invitation per email per organisation; accepted rows keep invited_email for history.
CREATE UNIQUE INDEX uq_org_members_invite ON org_members(organization_id, invited_email) WHERE accepted_at IS NULL;
