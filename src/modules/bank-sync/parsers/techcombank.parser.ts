import { normalizeAccountNumber } from '../domain/identifier-hmac';
import { parseVndAmount } from '../domain/vnd-amount';
import {
  BankNotificationInput,
  BankNotificationParser,
  OUT_UNVERIFIED,
  ParseResult,
  normalizeText,
} from './bank-notification-parser';

const VERSION = 'tcb@1';

export class TechcombankParser implements BankNotificationParser {
  readonly providerCode = 'TECHCOMBANK' as const;
  readonly version = VERSION;

  isBalanceMovement(input: BankNotificationInput): boolean {
    return (
      /[+-]\s*VND\s*\d/u.test(normalizeText(input.title)) ||
      /Số dư:\s*VND/u.test(input.body.normalize('NFC'))
    );
  }

  parse(input: BankNotificationInput): ParseResult {
    const title = normalizeText(input.title);
    const body = input.body.normalize('NFC');

    // Amount comes from the title only; the body also carries the balance.
    const amountMatch = /^([+-])\s*VND\s*([\d.,]+)$/.exec(title);
    if (!amountMatch) {
      return this.fail('PARSE_FAILED', 'AMOUNT_NOT_FOUND');
    }
    const amount = parseVndAmount(amountMatch[2]);
    if (!amount || amount < 1) {
      return this.fail('PARSE_FAILED', 'AMOUNT_INVALID');
    }
    const direction = amountMatch[1] === '+' ? 'IN' : 'OUT';

    const accounts = [
      ...body.matchAll(/^[ \t]*Tài khoản:[ \t]*([\d .-]+?)[ \t]*$/gmu),
    ].map((m) => normalizeAccountNumber(m[1]));
    const distinct = new Set(accounts);
    if (distinct.size > 1) {
      return this.fail('REVIEW', 'ACCOUNT_AMBIGUOUS');
    }
    const accountNumber = accounts[0] ?? null;

    const balances = [...body.matchAll(/Số dư:\s*VND\s*([\d.,]+)/gu)];
    const reportedBalanceMinor =
      balances.length === 1 ? parseVndAmount(balances[0][1]) : null;

    return {
      ok: true,
      event: {
        providerCode: this.providerCode,
        accountNumber,
        amountMinor: amount,
        direction,
        reportedBalanceMinor,
        transactionAt: null,
        externalReference: null,
        parserVersion: VERSION,
      },
      reviewReason: direction === 'OUT' ? OUT_UNVERIFIED : undefined,
    };
  }

  private fail(status: 'PARSE_FAILED' | 'REVIEW', reason: string): ParseResult {
    return { ok: false, status, reason, parserVersion: VERSION };
  }
}
