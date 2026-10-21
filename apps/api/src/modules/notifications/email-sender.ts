import { Logger } from '@nestjs/common';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/** Sends one email and returns the provider's message id; throws when the provider refuses it. */
export interface EmailSender {
  readonly name: string;
  send(email: OutgoingEmail): Promise<string>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * Stand-in until a real provider is chosen: logs each email and keeps the last ones in memory,
 * so tests and local development can see what would have gone out.
 */
export class FakeEmailSender implements EmailSender {
  readonly name = 'fake';
  readonly outbox: OutgoingEmail[] = [];
  private readonly logger = new Logger('FakeEmailSender');

  async send(email: OutgoingEmail): Promise<string> {
    this.outbox.push(email);
    if (this.outbox.length > 1000) this.outbox.shift();
    this.logger.log(`email to ${email.to}: ${email.subject}`);
    return `fake_msg_${this.outbox.length}_${Date.now()}`;
  }
}
