import { randomUUID } from 'node:crypto';
import { createEvent } from '../db/fixtures';
import { bootApp, call, TestContext, uniqueSlug } from './helpers';

describe('event search', () => {
  let ctx: TestContext;
  /** A word only this suite's events carry, so other suites' events stay out of the results. */
  const tag = `ค้นหา${randomUUID().slice(0, 6)}`;
  const DAY = 86_400_000;

  beforeAll(async () => {
    ctx = await bootApp();
    const tier = [{ name: 'ปกติ', priceSatang: 50_000 }];
    const race = (code: string, distanceKm: number, capacity = 100) => ({ code, nameTh: code, distanceKm, capacity, tiers: tier });
    await createEvent(ctx.pool, { slug: uniqueSlug(), nameTh: `มินิ ${tag}`, eventDate: '2027-03-07', provinceCode: 'CNX', races: [race('5K', 5), race('10K', 10)] });
    await createEvent(ctx.pool, { slug: uniqueSlug(), nameTh: `มาราธอน ${tag}`, eventDate: '2027-04-04', provinceCode: 'BKK', races: [race('42K', 42.195), race('21K', 21.1)] });
    await createEvent(ctx.pool, { slug: uniqueSlug(), nameTh: `อัลตรา ${tag}`, eventDate: '2027-04-18', provinceCode: 'BKK', races: [race('100K', 100, 0)] });
    await createEvent(ctx.pool, {
      slug: uniqueSlug(), nameTh: `ยังไม่เปิด ${tag}`, eventDate: '2027-05-02', provinceCode: 'PKT',
      opensAt: new Date(Date.now() + 10 * DAY), closesAt: new Date(Date.now() + 40 * DAY), races: [race('10K', 10)],
    });
  });
  afterAll(() => ctx.close());

  const names = async (query: string) => {
    const res = await call(ctx.app, 'GET', `/v1/events?q=${encodeURIComponent(tag)}&${query}`);
    expect(res.status).toBe(200);
    return (res.body.items as { name: { th: string } }[]).map((e) => e.name.th.replace(` ${tag}`, ''));
  };

  it('filters by distance band, province, month and what is open now', async () => {
    expect(await names('')).toEqual(['มินิ', 'มาราธอน', 'อัลตรา', 'ยังไม่เปิด']);
    expect(await names('distance=short')).toEqual(['มินิ']);
    expect(await names('distance=10k')).toEqual(['มินิ', 'ยังไม่เปิด']);
    expect(await names('distance=half')).toEqual(['มาราธอน']);
    expect(await names('distance=full')).toEqual(['มาราธอน']);
    expect(await names('distance=ultra')).toEqual(['อัลตรา']);
    expect(await names('province=BKK')).toEqual(['มาราธอน', 'อัลตรา']);
    expect(await names('month=2027-04')).toEqual(['มาราธอน', 'อัลตรา']);
    // The ultra has no places and the last one has not opened yet.
    expect(await names('open=1')).toEqual(['มินิ', 'มาราธอน']);
    expect(await names('open=0')).toHaveLength(4);
    expect(await names('province=BKK&distance=full&open=true')).toEqual(['มาราธอน']);
    expect((await call(ctx.app, 'GET', '/v1/events?distance=marathon')).status).toBe(422);
  });

  it('lists the provinces and months that have events', async () => {
    const res = await call(ctx.app, 'GET', '/v1/events/filters');
    expect(res.status).toBe(200);
    expect(res.body.provinces).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CNX' }), expect.objectContaining({ code: 'PKT' })]));
    const bkk = res.body.provinces.find((p: { code: string }) => p.code === 'BKK');
    expect(bkk.count).toBeGreaterThanOrEqual(2);
    expect(res.body.months).toEqual(expect.arrayContaining([expect.objectContaining({ month: '2027-04' })]));
  });
});
