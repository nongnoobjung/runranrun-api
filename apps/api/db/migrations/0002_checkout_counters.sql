-- Price tiers need the same hold-then-commit counter as races, otherwise an
-- Early bird quota can be oversold while payments are still pending.
ALTER TABLE price_tiers
  ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0);
ALTER TABLE price_tiers
  DROP CONSTRAINT IF EXISTS price_tiers_check1;
ALTER TABLE price_tiers
  ADD CONSTRAINT price_tiers_quota_capacity_check CHECK (quota IS NULL OR sold + reserved <= quota);

-- Human-readable running numbers.
CREATE SEQUENCE order_no_seq START 100;
CREATE SEQUENCE registration_no_seq START 1000;

-- Availability now accounts for tier reservations.
CREATE OR REPLACE VIEW v_race_availability AS
SELECT r.id AS race_id, r.event_id, r.code, r.capacity, r.sold, r.reserved,
       GREATEST(r.capacity - r.sold - r.reserved, 0) AS available,
       (SELECT pt.price_satang FROM price_tiers pt
         WHERE pt.race_id = r.id AND now() >= pt.starts_at AND now() < pt.ends_at
           AND (pt.quota IS NULL OR pt.sold + pt.reserved < pt.quota)
         ORDER BY pt.starts_at LIMIT 1) AS current_price_satang
FROM races r
WHERE r.is_active;
