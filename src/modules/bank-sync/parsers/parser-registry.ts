import type {
  BankNotificationParser,
  ProviderCode,
} from './bank-notification-parser';
import { TechcombankParser } from './techcombank.parser';
import { VcbReceiptParser } from './vcb-receipt.parser';
import { VcbParser } from './vcb.parser';

export const SUPPORTED_PROVIDERS: readonly ProviderCode[] = [
  'TECHCOMBANK',
  'VCB',
];

// App display names as iOS reports them; add aliases when a bank renames its app.
const APP_ALIASES: Record<string, ProviderCode> = {
  techcombank: 'TECHCOMBANK',
  'techcombank mobile': 'TECHCOMBANK',
  'vcb digibank': 'VCB',
  'vcb-digibank': 'VCB',
  vietcombank: 'VCB',
  gmail: 'VCB',
};

const PARSERS: Record<ProviderCode, BankNotificationParser> = {
  TECHCOMBANK: new TechcombankParser(),
  VCB: new VcbParser(),
};

// Gmail reads VCB OUT receipts only; IN comes from the VCB app push.
const APP_PARSERS: Record<string, BankNotificationParser> = {
  gmail: new VcbReceiptParser(),
};

function appKey(app: string): string {
  return app.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function providerForApp(app: string): ProviderCode | null {
  return APP_ALIASES[appKey(app)] ?? null;
}

export function parserFor(
  provider: ProviderCode,
  app?: string,
): BankNotificationParser {
  return (app !== undefined && APP_PARSERS[appKey(app)]) || PARSERS[provider];
}

export function isProviderCode(value: unknown): value is ProviderCode {
  return (
    typeof value === 'string' &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
  );
}
