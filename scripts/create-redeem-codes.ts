/**
 * Mint activation codes.
 *
 * A CLI rather than an admin UI, and deliberately so: one person operates this,
 * a few times a week. A web admin needs its own route, its own auth (there is
 * no admin concept on `Profile`), its own guard and its own screens — hundreds
 * of lines for something a terminal does in five seconds. Prisma Studio
 * (`pnpm prisma:studio`) already covers looking a code back up.
 *
 *   pnpm redeem:create -- --campaign=beta-2026-q1 --count=50 \
 *     --grant=duration_days --days=90 --expires=2026-12-31 \
 *     --note="Beta đợt 1"
 *
 *   pnpm redeem:create -- --campaign=shopee-tet --count=200 \
 *     --grant=duration_days --days=365
 *
 *   pnpm redeem:create -- --campaign=founder --count=10 --grant=lifetime
 *
 * Prints CSV on stdout, ready to paste into a sheet and send to customers.
 */
import { PrismaClient } from '@prisma/client';
import { generateRedeemCodes } from '../src/modules/billing/domain/redeem-code-format';
import { uuidv7 } from '../src/common/utils/uuid';

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const campaign = args.campaign;
  if (!campaign) fail('--campaign is required');

  const count = Number(args.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 5000) {
    fail('--count must be between 1 and 5000');
  }

  const grantType = (args.grant ?? 'duration_days') as
    | 'duration_days'
    | 'until_date'
    | 'lifetime';
  if (!['duration_days', 'until_date', 'lifetime'].includes(grantType)) {
    fail('--grant must be duration_days, until_date or lifetime');
  }

  let grantDurationDays: number | null = null;
  let grantUntil: Date | null = null;

  if (grantType === 'duration_days') {
    grantDurationDays = Number(args.days);
    if (!Number.isInteger(grantDurationDays) || grantDurationDays < 1) {
      fail('--days is required for --grant=duration_days');
    }
  }

  if (grantType === 'until_date') {
    grantUntil = new Date(args.until ?? '');
    if (Number.isNaN(grantUntil.getTime())) {
      fail('--until=YYYY-MM-DD is required for --grant=until_date');
    }
  }

  const expiresAt = args.expires ? new Date(args.expires) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    fail('--expires must be YYYY-MM-DD');
  }

  const maxRedemptions = Number(args['max-redemptions'] ?? 1);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
    fail('--max-redemptions must be a positive integer');
  }

  const prisma = new PrismaClient();
  const codes = generateRedeemCodes(count);

  try {
    await prisma.redeemCode.createMany({
      data: codes.map((code) => ({
        id: uuidv7(),
        code,
        campaign,
        grantType,
        grantDurationDays,
        grantUntil,
        maxRedemptions,
        expiresAt,
        note: args.note ?? '',
      })),
      // A collision against an existing code is astronomically unlikely at 35
      // bits, but skipping beats aborting a 200-code batch over one row.
      skipDuplicates: true,
    });

    console.log('code,campaign,grant,value,maxRedemptions,expiresAt');
    for (const code of codes) {
      const value =
        grantType === 'duration_days'
          ? String(grantDurationDays)
          : grantType === 'until_date'
            ? grantUntil!.toISOString().slice(0, 10)
            : '';
      console.log(
        [
          code,
          campaign,
          grantType,
          value,
          maxRedemptions,
          expiresAt?.toISOString().slice(0, 10) ?? '',
        ].join(','),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
