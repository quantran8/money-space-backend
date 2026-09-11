export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface CreatePaymentLinkInput {
  orderCode: number;
  /** Integer đồng. VND has no minor unit. */
  amount: number;
  /** At most 9 characters — see `PAYMENT_DESCRIPTION`. */
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Unix seconds. The link stops working after this. */
  expiredAt?: number;
}

export interface PaymentLink {
  checkoutUrl: string;
  /** The gateway's own id for the link, kept for support lookups. */
  paymentLinkId: string;
}

/**
 * What a payment provider has to be able to do.
 *
 * An interface with one implementation today, and deliberately so: adding VNPay
 * later (once a business licence and its 1.1–2.2% are worth paying) becomes one
 * new file behind this token rather than an edit through the payment service.
 *
 * Note what is NOT here: verifying a webhook. That is provider-specific in
 * shape as well as in algorithm, so it stays in the provider's own module —
 * `payos-signature.ts` — where it can be tested as pure functions.
 */
export interface PaymentGateway {
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink>;

  /**
   * Ask the provider what it thinks an order's state is.
   *
   * The webhook is the primary path; this is the fallback for when it never
   * arrives — a household staring at a return page needs an answer that does
   * not depend on a callback that may have been lost.
   */
  getPaymentLinkStatus(orderCode: number): Promise<{
    status: string;
    amountPaid: number;
    /** The settled transaction's reference, once there is one. */
    reference: string | null;
  }>;

  /** Stop accepting money for an order the household walked away from. */
  cancelPaymentLink(orderCode: number): Promise<void>;
}
