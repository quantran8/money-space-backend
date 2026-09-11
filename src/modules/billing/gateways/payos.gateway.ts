import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { billingConfig } from '../../../config/billing.config';
import { signPayload } from '../domain/payos-signature';
import type {
  CreatePaymentLinkInput,
  PaymentGateway,
  PaymentLink,
} from './payment-gateway.interface';

const DEFAULT_BASE_URL = 'https://api-merchant.payos.vn';

/** PayOS wraps everything in `{ code, desc, data }`. `'00'` is success. */
interface PayosEnvelope<T> {
  code?: string;
  desc?: string;
  data?: T;
  signature?: string;
}

interface PayosLinkData {
  checkoutUrl?: string;
  paymentLinkId?: string;
  status?: string;
  amountPaid?: number;
  transactions?: Array<{ reference?: string }>;
}

/**
 * PayOS adapter (https://payos.vn).
 *
 * **No `@payos/node` SDK, on purpose.** This is three HTTP calls and one HMAC;
 * a dependency for that is a dependency to keep patched, audited and in step
 * with a Nest upgrade, in the one part of the app that handles money. Written
 * by hand it matches the vnstock and CoinMarketCap adapters already here, and
 * it is testable without a network.
 *
 * Requests carry a `signature` of their own — PayOS signs both directions, and
 * a create call without one is rejected.
 */
@Injectable()
export class PayosGateway implements PaymentGateway {
  private readonly logger = new Logger(PayosGateway.name);
  private readonly baseUrl = (
    process.env.PAYOS_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/$/, '');

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
    // The REQUEST signature covers a fixed, documented subset of the fields in
    // a fixed order — not the alphabetical sort the webhook uses. They are
    // genuinely different schemes; `signPayload` sorts, so the subset is built
    // as an object whose sorted order happens to be the documented one:
    // amount, cancelUrl, description, orderCode, returnUrl.
    const signature = signPayload(
      {
        amount: input.amount,
        cancelUrl: input.cancelUrl,
        description: input.description,
        orderCode: input.orderCode,
        returnUrl: input.returnUrl,
      },
      billingConfig.payosChecksumKey,
    );

    const data = await this.request<PayosLinkData>('/v2/payment-requests', {
      method: 'POST',
      body: JSON.stringify({ ...input, signature }),
    });

    if (!data.checkoutUrl) {
      throw new ServiceUnavailableException('payment_link_unavailable');
    }

    return {
      checkoutUrl: data.checkoutUrl,
      paymentLinkId: data.paymentLinkId ?? '',
    };
  }

  async getPaymentLinkStatus(orderCode: number) {
    const data = await this.request<PayosLinkData>(
      `/v2/payment-requests/${orderCode}`,
      { method: 'GET' },
    );

    return {
      status: data.status ?? 'UNKNOWN',
      amountPaid: data.amountPaid ?? 0,
      reference: data.transactions?.[0]?.reference ?? null,
    };
  }

  async cancelPaymentLink(orderCode: number): Promise<void> {
    await this.request(`/v2/payment-requests/${orderCode}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancellationReason: 'cancelled_by_user' }),
    });
  }

  /**
   * One call to PayOS.
   *
   * Everything upstream becomes a 503: a gateway that is down, slow or
   * answering nonsense is the same event to a household staring at a checkout
   * button, and none of it is their fault. The detail goes to the log, never
   * to the response — a PayOS error string can name our merchant account.
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    if (!billingConfig.payosConfigured) {
      // Refused at the button rather than halfway through a checkout.
      throw new ServiceUnavailableException('payments_unavailable');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': billingConfig.payosClientId,
          'x-api-key': billingConfig.payosApiKey,
        },
        // A household is watching a spinner. Better a clear failure than a
        // request that hangs until the platform's own timeout.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      this.logger.error(
        `PayOS ${path} request failed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('payment_gateway_unreachable');
    }

    if (!response.ok) {
      this.logger.error(`PayOS ${path} returned HTTP ${response.status}`);
      throw new ServiceUnavailableException('payment_gateway_error');
    }

    const body = (await response.json()) as PayosEnvelope<T>;
    if (body.code !== '00' || !body.data) {
      this.logger.error(
        `PayOS ${path} error: ${body.code ?? 'no code'} ${body.desc ?? ''}`,
      );
      throw new ServiceUnavailableException('payment_gateway_error');
    }

    return body.data;
  }
}
