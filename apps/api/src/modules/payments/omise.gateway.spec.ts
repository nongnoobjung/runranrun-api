import { InvalidWebhookError } from './gateway';
import { OmiseGateway } from './omise.gateway';

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const route = routes[`${init.method} ${new URL(url).pathname}`];
    if (!route) return new Response(JSON.stringify({ object: 'error', message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('OmiseGateway', () => {
  it('creates a PromptPay charge and returns the QR image', async () => {
    const http = fakeFetch({
      'POST /charges': {
        body: {
          object: 'charge', id: 'chrg_test_1', status: 'pending', expires_at: '2026-10-21T10:00:00Z',
          source: { scannable_code: { image: { download_uri: 'https://api.omise.co/charges/chrg_test_1/documents/qr' } } },
        },
      },
    });
    const gw = new OmiseGateway('skey_test_123', http.fn);
    const charge = await gw.createCharge({
      paymentId: 'pay-1', orderNo: 'KAO26-000100', amountSatang: 192_780, method: 'promptpay', returnUri: 'https://kao.example/orders/1',
    });
    expect(charge).toMatchObject({ chargeId: 'chrg_test_1', status: 'pending', qrImageUrl: expect.stringContaining('/documents/qr') });

    const sent = new URLSearchParams(http.calls[0].init.body as string);
    expect(sent.get('amount')).toBe('192780');
    expect(sent.get('currency')).toBe('thb');
    expect(sent.get('source[type]')).toBe('promptpay');
    const headers = http.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('skey_test_123:').toString('base64')}`);
    expect(headers['Idempotency-Key']).toBe('pay-1');
  });

  it('trusts the event fetched back from Omise, not the posted body', async () => {
    const http = fakeFetch({
      'GET /events/evnt_test_1': {
        body: { object: 'event', id: 'evnt_test_1', key: 'charge.complete', data: { object: 'charge', id: 'chrg_test_1', status: 'failed' } },
      },
    });
    const gw = new OmiseGateway('skey_test_123', http.fn);
    // The posted body claims success; Omise says the charge failed.
    const forged = JSON.stringify({ id: 'evnt_test_1', key: 'charge.complete', data: { object: 'charge', id: 'chrg_test_1', status: 'successful' } });
    const event = await gw.verifyWebhook(forged);
    expect(event).toMatchObject({ eventId: 'evnt_test_1', chargeId: 'chrg_test_1', outcome: 'failed' });
  });

  it('rejects events Omise does not know about', async () => {
    const gw = new OmiseGateway('skey_test_123', fakeFetch({}).fn);
    await expect(gw.verifyWebhook(JSON.stringify({ id: 'evnt_made_up' }))).rejects.toBeInstanceOf(InvalidWebhookError);
    await expect(gw.verifyWebhook('not json')).rejects.toBeInstanceOf(InvalidWebhookError);
  });
});
