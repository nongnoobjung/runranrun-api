export type PaymentMethod = 'promptpay' | 'card' | 'mobile_banking';

export interface CreateChargeInput {
  paymentId: string;
  orderNo: string;
  amountSatang: number;
  method: PaymentMethod;
  /** Omise.js card token, required for card payments. */
  cardToken?: string;
  /** Omise source type for mobile banking, e.g. mobile_banking_kbank. */
  bank?: string;
  returnUri: string;
}

export interface ChargeCreated {
  chargeId: string;
  status: 'pending' | 'succeeded' | 'failed';
  qrPayload?: string;
  qrImageUrl?: string;
  authorizeUri?: string;
  expiresAt?: Date;
  raw: unknown;
}

/** A webhook after the gateway has proven it is genuine. */
export interface VerifiedWebhook {
  eventId: string;
  eventType: string;
  chargeId: string | null;
  outcome: 'succeeded' | 'failed' | 'expired' | 'ignored';
  payload: unknown;
}

export interface PaymentGateway {
  readonly name: string;
  createCharge(input: CreateChargeInput): Promise<ChargeCreated>;
  /** Throws InvalidWebhookError when the request cannot be verified. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<VerifiedWebhook>;
}

export class InvalidWebhookError extends Error {}

export class GatewayError extends Error {
  constructor(message: string, readonly raw?: unknown) {
    super(message);
  }
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
