import { normalizeAccountNumber } from '../domain/identifier-hmac';
import { parseVndAmount } from '../domain/vnd-amount';
import {
  BankNotificationInput,
  BankNotificationParser,
  ParseResult,
  normalizeText,
} from './bank-notification-parser';
import { vnLocalToUtc } from './vcb.parser';

const VERSION = 'vcb-receipt@1';
const MARKER = /^\s*Tài khoản nguồn:/mu;
const TIME = /^(\d{2}):(\d{2})\b.*?\b(\d{2})\/(\d{2})\/(\d{4})$/u;

/**
 * VCB email receipt "Biên lai chuyển tiền qua tài khoản", read from Gmail.
 * Sent to the sender only, so always OUT. See memory/bank-sync.md.
 */
export class VcbReceiptParser implements BankNotificationParser {
  readonly providerCode = 'VCB' as const;
  readonly version = VERSION;

  isBalanceMovement(input: BankNotificationInput): boolean {
    return MARKER.test(input.body.normalize('NFC'));
  }

  parse(input: BankNotificationInput): ParseResult {
    const fields = receiptFields(input.body);
    if (!fields) {
      return this.fail('REVIEW', 'RECEIPT_AMBIGUOUS');
    }
    const field = (key: string): string => fields.get(key) ?? '';

    const amount = parseVndAmount(field('Số tiền').replace(/\s*VND$/u, ''));
    if (!amount || amount < 1) {
      return this.fail('PARSE_FAILED', 'AMOUNT_INVALID');
    }
    const fee = fields.has('Số tiền phí')
      ? parseVndAmount(field('Số tiền phí').replace(/\s*VND$/u, ''))
      : 0;
    if (fee === null) {
      return this.fail('PARSE_FAILED', 'FEE_INVALID');
    }
    const senderPaysFee = /^Người chuyển/u.test(field('Loại phí'));

    const account = /^\d{6,19}$/.test(field('Tài khoản nguồn'))
      ? field('Tài khoản nguồn')
      : null;

    const time = TIME.exec(field('Ngày, giờ giao dịch'));
    if (!time) {
      return this.fail('PARSE_FAILED', 'TIME_NOT_FOUND');
    }
    const [, hh, mi, dd, mm, yyyy] = time;
    const transactionAt = vnLocalToUtc(+yyyy, +mm, +dd, +hh, +mi, 0);
    if (!transactionAt) {
      return this.fail('REVIEW', 'TIME_INVALID');
    }

    return {
      ok: true,
      event: {
        providerCode: this.providerCode,
        accountNumber: account && normalizeAccountNumber(account),
        amountMinor: amount + (senderPaysFee ? fee : 0),
        direction: 'OUT',
        reportedBalanceMinor: null,
        transactionAt,
        externalReference: null,
        parserVersion: VERSION,
      },
    };
  }

  private fail(status: 'PARSE_FAILED' | 'REVIEW', reason: string): ParseResult {
    return { ok: false, status, reason, parserVersion: VERSION };
  }
}

/** `Key: value` lines; null when a key repeats. */
function receiptFields(body: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const line of body.normalize('NFC').split(/\r?\n/)) {
    const match = /^([^:]+):(.*)$/u.exec(line);
    if (!match) continue;
    const key = normalizeText(match[1]);
    if (fields.has(key)) return null;
    fields.set(key, normalizeText(match[2]));
  }
  return fields;
}
