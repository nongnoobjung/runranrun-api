import { renderTemplate, TEMPLATE_KEYS, TemplateKey, TemplateVars } from './templates';

const event = { th: 'วิ่งริมน้ำ', en: 'River Run' };
const name = { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' };
const samples: { [K in TemplateKey]: TemplateVars[K] } = {
  order_paid: { orderId: 'o1', orderNo: 'KAO26-000001', event, eventDate: '2027-02-14', totalSatang: 192_780, registrations: [{ id: 'r1', name, raceCode: '21K', bib: null }] },
  bib_assigned: { registrationId: 'r1', event, raceCode: '21K', name, bib: '0042', previousBib: null },
  refund_approved: { event, raceCode: null, name: null, amountSatang: 50_000, byTransfer: true },
  refund_rejected: { event, raceCode: '10K', name, note: null },
  refund_transferred: { event, raceCode: '10K', name, amountSatang: 40_000, reference: 'KBANK 1' },
  transfer_sent: { event, raceCode: '10K', toName: name },
  transfer_received: { registrationId: 'r2', event, raceCode: '10K', name, bib: '2001' },
  race_change_completed: { registrationId: 'r1', event, fromRace: '21K', toRace: '10K', name, bib: null },
  waitlist_offer: { event, eventSlug: 'river-run', raceCode: '10K', expiresAt: '2027-01-01T10:00:00.000Z' },
  results_published: { event, eventSlug: 'river-run', raceCode: '10K', name, timeMs: 3_130_000, rank: 3 },
};

describe('transactional email templates', () => {
  it.each(TEMPLATE_KEYS)('%s reads in Thai and English with links in the right language', (key) => {
    const th = renderTemplate(key, samples[key] as never, 'th', 'https://kao.run/');
    const en = renderTemplate(key, samples[key] as never, 'en', 'https://kao.run/');
    expect(th.subject).toContain('วิ่งริมน้ำ');
    expect(en.subject).toContain('River Run');
    // Thai letters only; the baht sign sits in the same Unicode block.
    expect(en.subject).not.toMatch(/[ก-ฺเ-๛]/);
    expect(th.text).not.toContain('https://kao.run/en/');
    if (en.text.includes('https://')) expect(en.text).toContain('https://kao.run/en/');
  });

  it('falls back to the Thai event name when there is no English one', () => {
    const v = { ...samples.waitlist_offer, event: { th: 'วิ่งริมน้ำ', en: null } };
    expect(renderTemplate('waitlist_offer', v, 'en', 'https://kao.run').subject).toBe('A place is yours: วิ่งริมน้ำ 10K');
  });

  it('formats money, dates (Gregorian years in Thai too) and finishing times', () => {
    expect(renderTemplate('order_paid', samples.order_paid, 'th', 'https://kao.run').text).toContain('2027');
    expect(renderTemplate('order_paid', samples.order_paid, 'en', 'https://kao.run').text).toContain('฿1,927.80');
    expect(renderTemplate('results_published', samples.results_published, 'th', 'https://kao.run').text).toContain('เวลา 0:52:10 · อันดับ 3');
  });
});
