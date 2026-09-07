import { buildPlanOffers, findAvailableOffer } from './plan-pricing';

const NOW = new Date('2026-09-07T10:00:00.000Z');

type EnvOverrides = {
  monthlyPercent?: number;
  yearlyPercent?: number;
  lifetimePercent?: number;
  label?: string;
  startsAt?: string;
  endsAt?: string;
  lifetimeEnabled?: boolean;
};

/**
 * Sets the real environment variables rather than patching the config object.
 * `billingConfig` reads `process.env` through getters — precisely so a value
 * `ConfigModule` loads after import is still picked up — so this is also what
 * proves that indirection works.
 */
function withEnv(over: EnvOverrides, run: () => void) {
  const keys = [
    'BILLING_DISCOUNT_MONTHLY_PERCENT',
    'BILLING_DISCOUNT_YEARLY_PERCENT',
    'BILLING_DISCOUNT_LIFETIME_PERCENT',
    'BILLING_DISCOUNT_LABEL',
    'BILLING_DISCOUNT_STARTS_AT',
    'BILLING_DISCOUNT_ENDS_AT',
    'BILLING_LIFETIME_ENABLED',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  assign('BILLING_DISCOUNT_MONTHLY_PERCENT', over.monthlyPercent?.toString() ?? '0');
  assign('BILLING_DISCOUNT_YEARLY_PERCENT', over.yearlyPercent?.toString() ?? '0');
  assign('BILLING_DISCOUNT_LIFETIME_PERCENT', over.lifetimePercent?.toString() ?? '0');
  assign('BILLING_DISCOUNT_LABEL', over.label ?? '');
  assign('BILLING_DISCOUNT_STARTS_AT', over.startsAt ?? '');
  assign('BILLING_DISCOUNT_ENDS_AT', over.endsAt ?? '');
  assign(
    'BILLING_LIFETIME_ENABLED',
    over.lifetimeEnabled === false ? 'false' : 'true',
  );

  try {
    run();
  } finally {
    for (const key of keys) assign(key, original[key]);
  }
}

function offer(code: string, now = NOW) {
  return buildPlanOffers(now).find((item) => item.planCode === code)!;
}

describe('buildPlanOffers', () => {
  it('prices the three plans at list when nothing is running', () => {
    withEnv({}, () => {
      expect(offer('premium_monthly').amount).toBe(39_000);
      expect(offer('premium_yearly').amount).toBe(299_000);
      expect(offer('premium_lifetime').amount).toBe(699_000);
    });
  });

  /** 468.000đ is derived from the monthly price, never typed by hand. */
  it('compares the yearly plan against twelve monthly payments', () => {
    withEnv({}, () => {
      const yearly = offer('premium_yearly');

      expect(yearly.compareAtAmount).toBe(468_000);
      expect(yearly.savingsAmount).toBe(169_000);
      expect(yearly.monthlyEquivalent).toBe(25_000);
    });
  });

  it('applies a per-plan discount and rounds to whole thousands', () => {
    withEnv({ yearlyPercent: 20, label: 'Tết 2027' }, () => {
      const yearly = offer('premium_yearly');

      expect(yearly.discountAmount).toBe(60_000);
      expect(yearly.amount).toBe(239_000);
      expect(yearly.discountLabel).toBe('Tết 2027');
      // Savings grow with the discount — measured against 12 months, not list.
      expect(yearly.savingsAmount).toBe(229_000);
      // The other plans are untouched.
      expect(offer('premium_monthly').amount).toBe(39_000);
    });
  });

  it('shows no badge when a discount is configured without a label', () => {
    withEnv({ monthlyPercent: 10, label: '' }, () => {
      expect(offer('premium_monthly').discountLabel).toBeNull();
    });
  });

  it('ignores discounts before the campaign starts and after it ends', () => {
    withEnv(
      { yearlyPercent: 50, startsAt: '2026-10-01', endsAt: '2026-10-31' },
      () => {
        expect(offer('premium_yearly', new Date('2026-09-07')).amount).toBe(299_000);
        // 50% of 299.000 is 149.500, rounded to 150.000 off.
        expect(offer('premium_yearly', new Date('2026-10-15')).amount).toBe(149_000);
        expect(offer('premium_yearly', new Date('2026-11-05')).amount).toBe(299_000);
      },
    );
  });

  it('marks lifetime unavailable when the switch is off, leaving others alone', () => {
    withEnv({ lifetimeEnabled: false }, () => {
      expect(offer('premium_lifetime').available).toBe(false);
      expect(offer('premium_monthly').available).toBe(true);
      expect(findAvailableOffer('premium_lifetime', NOW)).toBeUndefined();
    });
  });

  it('gives lifetime no duration and no monthly equivalent', () => {
    const lifetime = offer('premium_lifetime');

    expect(lifetime.durationDays).toBeNull();
    expect(lifetime.monthlyEquivalent).toBeNull();
    expect(lifetime.savingsAmount).toBeNull();
  });
});
