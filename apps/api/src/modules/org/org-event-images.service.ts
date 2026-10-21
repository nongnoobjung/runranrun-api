import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { prepareImage } from '../../common/images';
import { ProblemException, problems } from '../../common/problem';
import { FILE_STORAGE, FileStorage } from '../../common/storage';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';

/** Where an uploaded image goes once stored; `description` images are only referenced from the Markdown. */
export const IMAGE_PURPOSES = ['cover', 'gallery', 'description', 'route_map'] as const;

export const imageUploadSchema = z
  .object({
    purpose: z.enum(IMAGE_PURPOSES).default('description'),
    /** The race whose route map this is (purpose route_map only). */
    raceId: z.string().uuid().optional(),
  })
  .refine((v) => v.purpose !== 'route_map' || v.raceId, { message: 'Pick the race', path: ['raceId'] });

const MAX_GALLERY = 30;
const MAX_IMAGES_PER_EVENT = 120;

export const gallerySchema = z.object({
  items: z
    .array(
      z.object({
        imageId: z.string().uuid(),
        captionTh: z.string().trim().max(200).nullable().default(null),
        captionEn: z.string().trim().max(200).nullable().default(null),
      }),
    )
    .max(MAX_GALLERY)
    .refine((items) => new Set(items.map((i) => i.imageId)).size === items.length, 'Each image can be in the gallery once'),
});
export type GalleryItem = z.infer<typeof gallerySchema>['items'][number];

/**
 * Public path of an event image. The web app serves /media/* from the API's /v1/media/*, so the path works on the
 * runner site whatever host it runs on, and can sit inside the description's Markdown as it is.
 */
export const eventImageUrl = (id: string) => `/media/event-images/${id}.webp`;
export const EVENT_IMAGE_URL = /^\/media\/event-images\/([0-9a-f-]{36})\.webp$/;

type Queryable = Pick<PoolClient, 'query'>;

/** The gallery as stored, joined to its images; entries whose image is gone are skipped. */
export async function loadGallery(client: Queryable, eventId: string, gallery: GalleryItem[]) {
  if (gallery.length === 0) return [];
  const { rows } = await client.query<{ id: string; width: number; height: number }>(
    'SELECT id, width, height FROM event_images WHERE event_id = $1 AND id = ANY($2::uuid[])',
    [eventId, gallery.map((g) => g.imageId)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return gallery.flatMap((g) => {
    const img = byId.get(g.imageId);
    return img ? [{ id: img.id, url: eventImageUrl(img.id), width: img.width, height: img.height, captionTh: g.captionTh, captionEn: g.captionEn }] : [];
  });
}

/**
 * Stores an already-prepared image for an event. Shared with the seed, which has no request to go through.
 * The caller holds the transaction; the file is written first and must be removed by the caller if it rolls back.
 */
export async function insertEventImage(
  client: Queryable,
  storage: FileStorage,
  input: { eventId: string; userId: string | null; image: Awaited<ReturnType<typeof prepareImage>> },
) {
  const id = randomUUID();
  const key = `event-images/${input.eventId}/${id}.webp`;
  await storage.put(key, input.image.body, input.image.contentType);
  await client.query(
    `INSERT INTO event_images (id, event_id, storage_key, content_type, width, height, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.eventId, key, input.image.contentType, input.image.width, input.image.height, input.image.body.length, input.userId],
  );
  return { id, key, url: eventImageUrl(id), width: input.image.width, height: input.image.height };
}

/**
 * Images on the public event page: the cover, the gallery, pictures inside the description and race route maps.
 * Only the team's owners and admins (manage_event) reach these; every change is written to audit_logs.
 */
@Injectable()
export class OrgEventImagesService {
  constructor(
    private readonly dbs: DbService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async upload(userId: string, orgId: string, eventId: string, input: z.infer<typeof imageUploadSchema>, body: Buffer) {
    const image = await prepareImage(body);
    let stored: { key: string } | null = null;
    const released: string[] = [];
    try {
      const result = await this.dbs.transaction(async (_tx, client) => {
        const ev = await client.query<{ cover_image_url: string | null; gallery: GalleryItem[] }>(
          'SELECT cover_image_url, gallery FROM events WHERE id = $1 FOR UPDATE',
          [eventId],
        );
        const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM event_images WHERE event_id = $1', [eventId]);
        if (count.rows[0].n >= MAX_IMAGES_PER_EVENT) {
          throw new ProblemException(409, 'TOO_MANY_IMAGES', `An event can keep at most ${MAX_IMAGES_PER_EVENT} images; delete unused ones first`);
        }
        if (input.purpose === 'gallery' && ev.rows[0].gallery.length >= MAX_GALLERY) {
          throw new ProblemException(409, 'GALLERY_FULL', `The gallery holds at most ${MAX_GALLERY} images`);
        }
        let previous: string | null = null;
        if (input.purpose === 'route_map') {
          const race = await client.query<{ route_map_url: string | null }>(
            'SELECT route_map_url FROM races WHERE id = $1 AND event_id = $2 AND is_active FOR UPDATE',
            [input.raceId, eventId],
          );
          if (!race.rows[0]) throw problems.notFound('Race');
          previous = race.rows[0].route_map_url;
        }

        const img = await insertEventImage(client, this.storage, { eventId, userId, image });
        stored = img;
        if (input.purpose === 'cover') {
          previous = ev.rows[0].cover_image_url;
          await client.query('UPDATE events SET cover_image_url = $2, updated_at = now() WHERE id = $1', [eventId, img.url]);
        } else if (input.purpose === 'gallery') {
          const gallery = [...ev.rows[0].gallery, { imageId: img.id, captionTh: null, captionEn: null }];
          await client.query('UPDATE events SET gallery = $2, updated_at = now() WHERE id = $1', [eventId, JSON.stringify(gallery)]);
        } else if (input.purpose === 'route_map') {
          await client.query('UPDATE races SET route_map_url = $2, updated_at = now() WHERE id = $1', [input.raceId, img.url]);
        }
        // A replaced cover or route map that nothing else shows is deleted, so replacing does not pile up files.
        if (previous) {
          const key = await this.releaseIfUnused(client, eventId, previous);
          if (key) released.push(key);
        }
        await writeAudit(client, {
          actorId: userId, organizationId: orgId, eventId, action: 'event.image_upload', entityType: 'event_image', entityId: img.id,
          after: { purpose: input.purpose, raceId: input.raceId, width: img.width, height: img.height, sizeBytes: image.body.length },
        });
        return { id: img.id, url: img.url, width: img.width, height: img.height, purpose: input.purpose };
      });
      await Promise.all(released.map((key) => this.storage.delete(key)));
      return result;
    } catch (err) {
      if (stored) await this.storage.delete((stored as { key: string }).key);
      throw err;
    }
  }

  /**
   * Deletes an image: it leaves the gallery, and a cover or route map showing it goes back to none. A description
   * that still links to it shows nothing in its place; the organiser removes the line from the text.
   */
  async delete(userId: string, orgId: string, eventId: string, imageId: string) {
    let key = '';
    await this.dbs.transaction(async (_tx, client) => {
      const ev = await client.query<{ gallery: GalleryItem[] }>('SELECT gallery FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const { rows } = await client.query<{ storage_key: string }>(
        'DELETE FROM event_images WHERE id = $1 AND event_id = $2 RETURNING storage_key',
        [imageId, eventId],
      );
      if (!rows[0]) throw problems.notFound('Image');
      key = rows[0].storage_key;
      const url = eventImageUrl(imageId);
      const gallery = ev.rows[0].gallery.filter((g) => g.imageId !== imageId);
      await client.query(
        `UPDATE events SET gallery = $2, cover_image_url = NULLIF(cover_image_url, $3), updated_at = now() WHERE id = $1`,
        [eventId, JSON.stringify(gallery), url],
      );
      await client.query('UPDATE races SET route_map_url = NULL, updated_at = now() WHERE event_id = $1 AND route_map_url = $2', [eventId, url]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'event.image_delete', entityType: 'event_image', entityId: imageId });
    });
    await this.storage.delete(key);
  }

  /** Replaces the gallery's order and captions; images left out stay stored (the description may use them). */
  async setGallery(userId: string, orgId: string, eventId: string, items: GalleryItem[]) {
    return this.dbs.transaction(async (_tx, client) => {
      const before = await client.query<{ gallery: GalleryItem[] }>('SELECT gallery FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const known = await client.query<{ id: string }>('SELECT id FROM event_images WHERE event_id = $1 AND id = ANY($2::uuid[])', [
        eventId,
        items.map((i) => i.imageId),
      ]);
      if (known.rows.length !== items.length) throw problems.notFound('Image');
      await client.query('UPDATE events SET gallery = $2, updated_at = now() WHERE id = $1', [eventId, JSON.stringify(items)]);
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, eventId, action: 'event.gallery_update', entityType: 'event', entityId: eventId,
        before: before.rows[0].gallery, after: items,
      });
      return { items: await loadGallery(client, eventId, items) };
    });
  }

  /** The stored bytes of a public event image, or null when there is no such image. */
  async publicFile(imageId: string): Promise<{ body: Buffer; contentType: string } | null> {
    const { rows } = await this.dbs.pool.query<{ storage_key: string; content_type: string }>(
      'SELECT storage_key, content_type FROM event_images WHERE id = $1',
      [imageId],
    );
    if (!rows[0]) return null;
    const body = await this.storage.get(rows[0].storage_key);
    return body && { body, contentType: rows[0].content_type };
  }

  /** Deletes an uploaded image of this event once nothing on the page shows it; returns its storage key to remove. */
  private async releaseIfUnused(client: Queryable, eventId: string, url: string): Promise<string | null> {
    const id = EVENT_IMAGE_URL.exec(url)?.[1];
    if (!id) return null;
    const { rows } = await client.query<{ storage_key: string }>(
      `DELETE FROM event_images i
        WHERE i.id = $1 AND i.event_id = $2
          AND NOT EXISTS (SELECT 1 FROM events e
                           WHERE e.id = $2
                             AND (e.cover_image_url = $3 OR e.gallery @> jsonb_build_array(jsonb_build_object('imageId', $1::text))
                                  OR strpos(COALESCE(e.description_th, ''), $3) > 0 OR strpos(COALESCE(e.description_en, ''), $3) > 0))
          AND NOT EXISTS (SELECT 1 FROM races r WHERE r.event_id = $2 AND r.route_map_url = $3)
        RETURNING storage_key`,
      [id, eventId, url],
    );
    return rows[0]?.storage_key ?? null;
  }
}
