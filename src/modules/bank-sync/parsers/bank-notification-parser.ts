export type ProviderCode = 'TECHCOMBANK' | 'VCB';
export type BankDirection = 'IN' | 'OUT';

export interface BankNotificationInput {
  title: string;
  body: string;
}

export interface ParsedBankEvent {
  providerCode: ProviderCode;
  /** Full number, RAM only — hash it and drop it. */
  accountNumber: string | null;
  amountMinor: number;
  direction: BankDirection;
  reportedBalanceMinor: number | null;
  /** Time read from the message itself, when it carries one. */
  transactionAt: Date | null;
  externalReference: string | null;
  parserVersion: string;
}

export type ParseResult =
  | { ok: true; event: ParsedBankEvent }
  | {
      ok: false;
      status: 'PARSE_FAILED' | 'REVIEW';
      reason: string;
      parserVersion: string;
    };

export interface BankNotificationParser {
  readonly providerCode: ProviderCode;
  readonly version: string;
  /** Cheap signal check; false = promo/system message, never stored. */
  isBalanceMovement(input: BankNotificationInput): boolean;
  parse(input: BankNotificationInput): ParseResult;
}

/** NFC + collapsed whitespace, so composed/decomposed Vietnamese match alike. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
}
