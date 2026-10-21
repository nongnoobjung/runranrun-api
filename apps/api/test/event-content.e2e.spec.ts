import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, call, login, multipart, TestContext, uniqueSlug } from './helpers';

const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#1d3d66' } }).jpeg().toBuffer();
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: '#ff6b3d80' } }).png().toBuffer();

const DESCRIPTION = `## เส้นทาง

วิ่ง**ปิดถนน** _ตลอดสาย_

- น้ำทุก 2 กม.
- เหรียญทุกระยะ

[แผนที่](https://riverside.example/map) <script>alert(1)</script>`;

describe('event content and images', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A published event in its own organisation, plus a signed-in member with the given role. */
  async function orgEvent(role: 'owner' | 'admin' | 'finance' | 'staff' | 'viewer' = 'owner') {
    const slug = uniqueSlug();
    const created = await createEvent(
      ctx.pool,
      {
        slug,
        nameTh: 'งานมีรูป',
        eventDate: '2027-03-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] }],
      },
      uniqueSlug('org'),
    );
    const email = `${role}-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, role);
    const { token } = await login(ctx.app, email);
    return { ...created, slug, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  async function upload(token: string | null, base: string, fields: Record<string, string>, file?: { name: string; type: string; body: Buffer }) {
    const { payload, headers } = multipart(fields, file);
    const res = await ctx.app.inject({ method: 'POST', url: `${base}/images`, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function media(url: string) {
    const res = await ctx.app.inject({ method: 'GET', url: url.replace(/^\/media\//, '/v1/media/') });
    return { status: res.statusCode, body: res.rawPayload, headers: res.headers };
  }

  it('saves Thai and English content, keeps the Markdown as written and shows both on the public page', async () => {
    const ev = await orgEvent();
    const faq = [
      { qTh: 'รับเสื้อที่ไหน', aTh: 'ลานริมน้ำ', qEn: 'Where do I get my shirt?', aEn: 'At the riverside' },
      { qTh: 'จอดรถได้ไหม', aTh: 'ได้ 200 คัน' },
    ];
    const patch = {
      nameEn: 'Pictures Run', summaryTh: 'วิ่งริมน้ำ', summaryEn: 'A run by the river', descriptionTh: DESCRIPTION,
      descriptionEn: '## Route\n\n**Closed** roads', rulesTh: '- ติดบิบด้านหน้า', rulesEn: '- Bib on the front', faq,
    };
    const res = await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: patch });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...patch, faq: [faq[0], { ...faq[1], qEn: null, aEn: null }], gallery: [] });

    const again = await call(ctx.app, 'GET', ev.base, { token: ev.token });
    expect(again.body.descriptionTh).toBe(DESCRIPTION);

    const pub = await call(ctx.app, 'GET', `/v1/events/${ev.slug}`);
    expect(pub.body).toMatchObject({
      name: { th: 'งานมีรูป', en: 'Pictures Run' },
      summary: { th: 'วิ่งริมน้ำ', en: 'A run by the river' },
      description: { th: DESCRIPTION, en: '## Route\n\n**Closed** roads' },
      rules: { th: '- ติดบิบด้านหน้า', en: '- Bib on the front' },
      faq: [
        { q: { th: 'รับเสื้อที่ไหน', en: 'Where do I get my shirt?' }, a: { th: 'ลานริมน้ำ', en: 'At the riverside' } },
        { q: { th: 'จอดรถได้ไหม', en: null }, a: { th: 'ได้ 200 คัน', en: null } },
      ],
      gallery: [],
    });

    // Clearing the English side brings back null, so the page falls back to Thai.
    const cleared = await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { summaryEn: null, descriptionEn: null } });
    expect(cleared.body).toMatchObject({ summaryEn: null, descriptionEn: null, summaryTh: 'วิ่งริมน้ำ' });
  });

  it('rejects an FAQ entry without a Thai question and a cover that is neither a URL nor an uploaded image', async () => {
    const ev = await orgEvent();
    const bad = await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { faq: [{ qTh: '', aTh: 'ตอบ' }] } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ path: 'faq.0.qTh' })]);
    expect((await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { coverImageUrl: 'javascript:alert(1)' } })).status).toBe(422);
    expect((await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { coverImageUrl: 'https://cdn.example/cover.jpg' } })).status).toBe(200);
  });

  it('resizes an uploaded cover to WebP with the same shape, serves it publicly with long caching and replaces the old one', async () => {
    const ev = await orgEvent();
    const first = await upload(ev.token, ev.base, { purpose: 'cover' }, { name: 'cover.jpg', type: 'image/jpeg', body: await jpeg(3000, 1500) });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ purpose: 'cover', width: 2000, height: 1000, url: expect.stringMatching(/^\/media\/event-images\/[0-9a-f-]{36}\.webp$/) });

    const file = await media(first.body.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(await sharp(file.body).metadata()).toMatchObject({ format: 'webp', width: 2000, height: 1000 });

    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}`)).body.coverImageUrl).toBe(first.body.url);

    // A small PNG is not enlarged; the old cover is no longer shown anywhere, so it is deleted.
    const second = await upload(ev.token, ev.base, { purpose: 'cover' }, { name: 'c.png', type: 'image/png', body: await png(640, 480) });
    expect(second.body).toMatchObject({ width: 640, height: 480 });
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}`)).body.coverImageUrl).toBe(second.body.url);
    expect((await media(first.body.url)).status).toBe(404);
  });

  it('applies the photo orientation and drops EXIF data', async () => {
    const ev = await orgEvent();
    const sideways = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#000' } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'GPS somewhere' } } })
      .toBuffer();
    const res = await upload(ev.token, ev.base, {}, { name: 'phone.jpg', type: 'image/jpeg', body: sideways });
    expect(res.body).toMatchObject({ purpose: 'description', width: 200, height: 300 });
    const meta = await sharp((await media(res.body.url)).body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('keeps a gallery in the order and with the captions the organiser sets', async () => {
    const ev = await orgEvent('admin');
    const a = await upload(ev.token, ev.base, { purpose: 'gallery' }, { name: 'a.jpg', type: 'image/jpeg', body: await jpeg(800, 600) });
    const b = await upload(ev.token, ev.base, { purpose: 'gallery' }, { name: 'b.jpg', type: 'image/jpeg', body: await jpeg(600, 800) });
    expect((await call(ctx.app, 'GET', ev.base, { token: ev.token })).body.gallery.map((g: { id: string }) => g.id)).toEqual([a.body.id, b.body.id]);

    const items = [
      { imageId: b.body.id, captionTh: 'เส้นชัย', captionEn: 'Finish line' },
      { imageId: a.body.id, captionTh: 'จุดปล่อยตัว', captionEn: null },
    ];
    const res = await call(ctx.app, 'PUT', `${ev.base}/gallery`, { token: ev.token, body: { items } });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { id: b.body.id, url: b.body.url, width: 600, height: 800, captionTh: 'เส้นชัย', captionEn: 'Finish line' },
      { id: a.body.id, url: a.body.url, width: 800, height: 600, captionTh: 'จุดปล่อยตัว', captionEn: null },
    ]);
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}`)).body.gallery).toEqual([
      { id: b.body.id, url: b.body.url, width: 600, height: 800, caption: { th: 'เส้นชัย', en: 'Finish line' } },
      { id: a.body.id, url: a.body.url, width: 800, height: 600, caption: { th: 'จุดปล่อยตัว', en: null } },
    ]);

    expect((await call(ctx.app, 'PUT', `${ev.base}/gallery`, { token: ev.token, body: { items: [items[0], items[0]] } })).status).toBe(422);
    expect((await call(ctx.app, 'PUT', `${ev.base}/gallery`, { token: ev.token, body: { items: [{ imageId: randomUUID() }] } })).status).toBe(404);
    // Another event's image cannot be pulled into this gallery.
    const other = await orgEvent();
    const foreign = await upload(other.token, other.base, {}, { name: 'x.jpg', type: 'image/jpeg', body: await jpeg(100, 100) });
    expect((await call(ctx.app, 'PUT', `${ev.base}/gallery`, { token: ev.token, body: { items: [{ imageId: foreign.body.id }] } })).status).toBe(404);
  });

  it('deletes an image from storage, the gallery and the cover', async () => {
    const ev = await orgEvent();
    const g = await upload(ev.token, ev.base, { purpose: 'gallery' }, { name: 'g.jpg', type: 'image/jpeg', body: await jpeg(400, 300) });
    const c = await upload(ev.token, ev.base, { purpose: 'cover' }, { name: 'c.jpg', type: 'image/jpeg', body: await jpeg(400, 300) });

    expect((await call(ctx.app, 'DELETE', `${ev.base}/images/${g.body.id}`, { token: ev.token })).status).toBe(204);
    expect((await call(ctx.app, 'DELETE', `${ev.base}/images/${c.body.id}`, { token: ev.token })).status).toBe(204);
    expect((await call(ctx.app, 'DELETE', `${ev.base}/images/${c.body.id}`, { token: ev.token })).status).toBe(404);
    const after = await call(ctx.app, 'GET', ev.base, { token: ev.token });
    expect(after.body).toMatchObject({ gallery: [], coverImageUrl: null });
    expect((await media(g.body.url)).status).toBe(404);
    expect((await media(c.body.url)).status).toBe(404);
  });

  it('sets a race route map, shown with the race on the public page', async () => {
    const ev = await orgEvent();
    const raceId = ev.raceIds['10K'];
    expect((await upload(ev.token, ev.base, { purpose: 'route_map' }, { name: 'm.png', type: 'image/png', body: await png(500, 500) })).status).toBe(422);
    expect((await upload(ev.token, ev.base, { purpose: 'route_map', raceId: randomUUID() }, { name: 'm.png', type: 'image/png', body: await png(500, 500) })).status).toBe(404);
    const map = await upload(ev.token, ev.base, { purpose: 'route_map', raceId }, { name: 'm.png', type: 'image/png', body: await png(500, 500) });
    expect(map.status).toBe(201);
    const pub = await call(ctx.app, 'GET', `/v1/events/${ev.slug}`);
    expect(pub.body.races.find((r: { id: string }) => r.id === raceId).routeMapUrl).toBe(map.body.url);
    expect((await call(ctx.app, 'GET', ev.base, { token: ev.token })).body.races[0].routeMapUrl).toBe(map.body.url);
  });

  it('accepts only real JPG, PNG or WebP images up to 10 MB', async () => {
    const ev = await orgEvent();
    const webp = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).webp().toBuffer();
    expect((await upload(ev.token, ev.base, {}, { name: 'ok.webp', type: 'image/webp', body: webp })).status).toBe(201);

    const pdf = await upload(ev.token, ev.base, {}, { name: 'cover.jpg', type: 'image/jpeg', body: Buffer.from('%PDF-1.4\n%%EOF\n') });
    expect(pdf).toMatchObject({ status: 415, body: { code: 'UNSUPPORTED_IMAGE_TYPE' } });
    const gif = await upload(ev.token, ev.base, {}, { name: 'a.gif', type: 'image/gif', body: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;') });
    expect(gif.body.code).toBe('UNSUPPORTED_IMAGE_TYPE');
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    expect((await upload(ev.token, ev.base, {}, { name: 'b.png', type: 'image/png', body: broken })).body.code).toBe('INVALID_IMAGE');
    const huge = Buffer.concat([await jpeg(10, 10), Buffer.alloc(10 * 1024 * 1024)]);
    expect(await upload(ev.token, ev.base, {}, { name: 'big.jpg', type: 'image/jpeg', body: huge })).toMatchObject({ status: 413, body: { code: 'FILE_TOO_LARGE' } });
    expect((await upload(ev.token, ev.base, { purpose: 'cover' })).body.code).toBe('FILE_REQUIRED');
    expect((await upload(ev.token, ev.base, { purpose: 'poster' }, { name: 'a.jpg', type: 'image/jpeg', body: await jpeg(10, 10) })).status).toBe(422);
    expect((await call(ctx.app, 'POST', `${ev.base}/images`, { token: ev.token, body: {} })).status).toBe(415);
    // Nothing that failed was stored.
    const { rows } = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM event_images WHERE event_id = $1', [ev.eventId]);
    expect(rows[0].n).toBe(1);
  });

  it('lets only the team’s owners and admins change images', async () => {
    const ev = await orgEvent();
    const img = await upload(ev.token, ev.base, { purpose: 'gallery' }, { name: 'a.jpg', type: 'image/jpeg', body: await jpeg(100, 100) });
    const body = await jpeg(100, 100);

    for (const role of ['staff', 'finance', 'viewer'] as const) {
      const email = `${role}-${randomUUID()}@org.example`;
      await addOrgMember(ctx.pool, ev.organizationId, email, role);
      const { token } = await login(ctx.app, email);
      expect((await upload(token, ev.base, {}, { name: 'a.jpg', type: 'image/jpeg', body })).status).toBe(403);
      expect((await call(ctx.app, 'DELETE', `${ev.base}/images/${img.body.id}`, { token })).status).toBe(403);
      expect((await call(ctx.app, 'PUT', `${ev.base}/gallery`, { token, body: { items: [] } })).status).toBe(403);
    }
    const outsider = await orgEvent();
    expect((await upload(outsider.token, ev.base, {}, { name: 'a.jpg', type: 'image/jpeg', body })).status).toBe(404);
    expect((await call(ctx.app, 'DELETE', `${ev.base}/images/${img.body.id}`, { token: outsider.token })).status).toBe(404);
    // An owner of another team cannot delete this event's image through their own event either.
    expect((await call(ctx.app, 'DELETE', `${outsider.base}/images/${img.body.id}`, { token: outsider.token })).status).toBe(404);
    expect((await upload(null, ev.base, {}, { name: 'a.jpg', type: 'image/jpeg', body })).status).toBe(401);

    expect((await media(img.body.url)).status).toBe(200);
    const audit = await ctx.pool.query('SELECT action FROM audit_logs WHERE event_id = $1 ORDER BY created_at', [ev.eventId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['event.image_upload']);
  });

  it('answers 404 for an unknown or malformed image path', async () => {
    expect((await media(`/media/event-images/${randomUUID()}.webp`)).status).toBe(404);
    expect((await media('/media/event-images/..%2F..%2Fsecret.webp')).status).toBe(404);
    expect((await media('/media/event-images/abc.png')).status).toBe(404);
  });
});
