import { ChargeCreated, CreateChargeInput, GatewayError, InvalidWebhookError, PaymentGateway, VerifiedWebhook } from './gateway';

const OMISE_API = 'https://api.omise.co';

type Fetch = typeof fetch;

interface OmiseCharge {
  id: string;
  status: 'pending' | 'successful' | 'failed' | 'expired' | 'reversed';
  authorize_uri?: string | null;
  expires_at?: string | null;
  failure_message?: string | null;
  source?: { scannable_code?: { image?: { download_uri?: string } } } | null;
}

/**
 * Omise charges via the REST API. Webhooks are not trusted as sent: the event is fetched back
 * from Omise with the secret key, so a forged POST cannot mark an order paid.
 */
export class OmiseGateway implements PaymentGateway {
  readonly name = 'omise';

  constructor(
    private readonly secretKey: string,
    private readonly http: Fetch = fetch,
  ) {}

  async createCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    const form = new URLSearchParams({
      amount: String(input.amountSatang),
      currency: 'thb',
      return_uri: input.returnUri,
      'metadata[order_no]': input.orderNo,
      'metadata[payment_id]': input.paymentId,
    });
    if (input.method === 'promptpay') form.set('source[type]', 'promptpay');
    else if (input.method === 'mobile_banking') form.set('source[type]', input.bank ?? 'mobile_banking_kbank');
    else if (input.method === 'card') {
      if (!input.cardToken) throw new GatewayError('card token is required');
      form.set('card', input.cardToken);
    }

    const charge = await this.request<OmiseCharge>('POST', '/charges', form, input.paymentId);
    return {
      chargeId: charge.id,
      status: charge.status === 'successful' ? 'succeeded' : charge.status === 'pending' ? 'pending' : 'failed',
      qrImageUrl: charge.source?.scannable_code?.image?.download_uri,
      authorizeUri: charge.authorize_uri ?? undefined,
      expiresAt: charge.expires_at ? new Date(charge.expires_at) : undefined,
      raw: charge,
    };
  }

  async verifyWebhook(rawBody: string): Promise<VerifiedWebhook> {
    let claimed: { id?: unknown };
    try {
      claimed = JSON.parse(rawBody);
    } catch {
      throw new InvalidWebhookError('body is not JSON');
    }
    if (typeof claimed.id !== 'string' || !/^evnt_[a-z0-9_]+$/i.test(claimed.id)) throw new InvalidWebhookError('missing event id');

    let event: { id: string; key: string; data: { object: string } & Partial<OmiseCharge> };
    try {
      event = await this.request('GET', `/events/${claimed.id}`);
    } catch {
      throw new InvalidWebhookError('event not found at Omise');
    }
    const isCharge = event.data?.object === 'charge';
    const status = isCharge ? event.data.status : undefined;
    const outcome = !isCharge || !event.key.startsWith('charge.') ? 'ignored'
      : status === 'successful' ? 'succeeded'
      : status === 'failed' ? 'failed'
      : status === 'expired' ? 'expired' : 'ignored';
    return { eventId: event.id, eventType: event.key, chargeId: isCharge ? event.data.id ?? null : null, outcome, payload: event };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, form?: URLSearchParams, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
    };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.http(`${OMISE_API}${path}`, { method, headers, body: form?.toString() });
    const body = (await res.json()) as T & { object?: string; message?: string };
    if (!res.ok || body.object === 'error') throw new GatewayError(body.message ?? `Omise ${res.status}`, body);
    return body;
  }
}
