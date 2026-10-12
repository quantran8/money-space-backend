import type {
  BankNotificationParser,
  ProviderCode,
} from './bank-notification-parser';
import { TechcombankParser } from './techcombank.parser';
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
};

const PARSERS: Record<ProviderCode, BankNotificationParser> = {
  TECHCOMBANK: new TechcombankParser(),
  VCB: new VcbParser(),
};

export function providerForApp(app: string): ProviderCode | null {
  const key = app.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return APP_ALIASES[key] ?? null;
}

export function parserFor(provider: ProviderCode): BankNotificationParser {
  return PARSERS[provider];
}

export function isProviderCode(value: unknown): value is ProviderCode {
  return (
    typeof value === 'string' &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
  );
}
