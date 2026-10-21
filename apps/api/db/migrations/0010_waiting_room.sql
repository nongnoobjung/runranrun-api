-- Waiting room: how many runners per minute the queue lets through to checkout when use_waiting_room is on.
-- The queue itself lives in Redis; checkout_sessions.queue_token keeps the admission each session was opened with.
ALTER TABLE events ADD COLUMN queue_admit_per_minute INTEGER NOT NULL DEFAULT 100
  CHECK (queue_admit_per_minute BETWEEN 1 AND 10000);
