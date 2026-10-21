-- The checkout a waitlist offer was claimed into. While it is NULL an offered entry holds one of the race's
-- reserved places; once claimed, the checkout's own hold takes over.
ALTER TABLE waitlist_entries ADD COLUMN checkout_session_id UUID REFERENCES checkout_sessions(id);
