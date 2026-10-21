-- Images on an event page (cover, gallery, pictures inside the description, route maps). Unlike KYC documents they are
-- public: the API resizes them, keeps them under storage_key and serves them to anyone at /v1/media/event-images/<id>.webp.
-- The gallery's order and captions live in events.gallery as [{ imageId, captionTh, captionEn }].
CREATE TABLE event_images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  width        INTEGER NOT NULL CHECK (width > 0),
  height       INTEGER NOT NULL CHECK (height > 0),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_images_event ON event_images(event_id);

-- FAQ entries become bilingual: { q, a } (Thai) turns into { qTh, aTh, qEn, aEn }.
UPDATE events
   SET faq = (SELECT COALESCE(jsonb_agg(jsonb_build_object('qTh', f->>'q', 'aTh', f->>'a', 'qEn', NULL, 'aEn', NULL)), '[]')
                FROM jsonb_array_elements(faq) f)
 WHERE jsonb_typeof(faq) = 'array' AND jsonb_array_length(faq) > 0;
