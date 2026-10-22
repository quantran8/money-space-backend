import { normalizeAccountNumber } from '../domain/identifier-hmac';
import { parseVndAmount } from '../domain/vnd-amount';
import {
  BankNotificationInput,
  BankNotificationParser,
  ParseResult,
  normalizeText,
} from './bank-notification-parser';

const VERSION = 'vcb@1';
const VN_OFFSET_HOURS = 7;

const MOVEMENT =
  /Số dư TK VCB (\d{6,19}) ([+-])\s?([\d.,]+) VND lúc (\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/gu;
// The balance cluster; "Số dư TK VCB …" never matches since "TK" follows.
const BALANCE = /Số dư ([\d.,]+) VND/gu;

export class VcbParser implements BankNotificationParser {
  readonly providerCode = 'VCB' as const;
  readonly version = VERSION;

  isBalanceMovement(input: BankNotificationInput): boolean {
    return /Số dư TK VCB|Số dư [\d.,]+ VND/u.test(
      normalizeText(input.body.replace(/\s+/g, ' ')),
    );
  }

  parse(input: BankNotificationInput): ParseResult {
    const body = normalizeText(input.body.replace(/\s+/g, ' '));

    const movements = [...body.matchAll(MOVEMENT)];
    if (movements.length === 0) {
      return this.fail('PARSE_FAILED', 'MOVEMENT_NOT_FOUND');
    }
    if (movements.length > 1) {
      return this.fail('REVIEW', 'MOVEMENT_AMBIGUOUS');
    }
    const [, account, sign, rawAmount, dd, mm, yyyy, hh, mi, ss] = movements[0];

    const amount = parseVndAmount(rawAmount);
    if (!amount || amount < 1) {
      return this.fail('PARSE_FAILED', 'AMOUNT_INVALID');
    }
    const direction = sign === '+' ? 'IN' : 'OUT';

    const transactionAt = vnLocalToUtc(+yyyy, +mm, +dd, +hh, +mi, +ss);
    if (!transactionAt) {
      return this.fail('REVIEW', 'TIME_INVALID');
    }

    const balances = [...body.matchAll(BALANCE)];
    const reportedBalanceMinor =
      balances.length === 1 ? parseVndAmount(balances[0][1]) : null;

    return {
      ok: true,
      event: {
        providerCode: this.providerCode,
        accountNumber: normalizeAccountNumber(account),
        amountMinor: amount,
        direction,
        reportedBalanceMinor,
        transactionAt,
        // `Ref` is not proven unique yet. See memory/bank-sync.md.
        externalReference: null,
        parserVersion: VERSION,
      },
    };
  }

  private fail(status: 'PARSE_FAILED' | 'REVIEW', reason: string): ParseResult {
    return { ok: false, status, reason, parserVersion: VERSION };
  }
}

export function vnLocalToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): Date | null {
  const date = new Date(Date.UTC(y, mo - 1, d, h - VN_OFFSET_HOURS, mi, s));
  // Round-trip check rejects 31-02 and 25:00 instead of letting Date roll over.
  const back = new Date(date.getTime() + VN_OFFSET_HOURS * 3600_000);
  const valid =
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi &&
    back.getUTCSeconds() === s;
  return valid ? date : null;
}
