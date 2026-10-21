import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ChargeCreated, CreateChargeInput, InvalidWebhookError, PaymentGateway, VerifiedWebhook } from './gateway';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/**
 * Development/test gateway. Charges stay pending until a signed webhook arrives,
 * which the dev endpoint (or a test) produces with signFakeWebhook().
 */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake';

  constructor(private readonly secret: string) {}

  async createCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    const chargeId = `fake_chrg_${randomUUID().replace(/-/g, '')}`;
    return {
      chargeId,
      status: 'pending',
      // Not a scannable PromptPay code; the web app only needs a string to render.
      qrPayload: input.method === 'promptpay' ? `00020101021229370016A000000677010111${input.orderNo}5303764540${input.amountSatang}` : undefined,
      authorizeUri: input.method === 'mobile_banking' ? `${input.returnUri}?fake_charge=${chargeId}` : undefined,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      raw: { chargeId, input: { ...input, cardToken: undefined } },
    };
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<VerifiedWebhook> {
    const given = headers[FAKE_SIGNATURE_HEADER];
    const expected = signFakeWebhook(rawBody, this.secret);
    if (typeof given !== 'string' || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new InvalidWebhookError('bad signature');
    }
    const body = JSON.parse(rawBody) as { id: string; type: string; data: { id: string; status: string } };
    const outcome = body.type !== 'charge.complete' ? 'ignored'
      : body.data.status === 'successful' ? 'succeeded'
      : body.data.status === 'expired' ? 'expired'
      : body.data.status === 'failed' ? 'failed' : 'ignored';
    return { eventId: body.id, eventType: body.type, chargeId: body.data.id, outcome, payload: body };
  }
}

export function signFakeWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function fakeChargeCompleteBody(chargeId: string, status: 'successful' | 'failed' | 'expired', eventId = `fake_evt_${randomUUID()}`): string {
  return JSON.stringify({ id: eventId, type: 'charge.complete', data: { id: chargeId, status } });
}
