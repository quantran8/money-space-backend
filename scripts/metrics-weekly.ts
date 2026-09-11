/**
 * The weekly numbers, from Postgres only.
 *
 * A CLI rather than a dashboard, for the same reason `create-redeem-codes.ts`
 * is one: one person reads this, once a week. Prisma Studio and a terminal
 * already cover it, and a self-built admin page would need its own route, auth
 * and screens for what a query answers in a second.
 *
 * It needs no PostHog and no network — everything here is already in the
 * database, which makes it the half of analytics that works on day one, before
 * a single SDK key exists.
 *
 *   pnpm metrics:weekly                 # 8 weeks, printed
 *   pnpm metrics:weekly -- --weeks=12
 *   pnpm metrics:weekly -- --csv > metrics.csv
 *   pnpm metrics:weekly -- --push       # also send to PostHog
 *
 * `--push` is what the weekly workflow runs, and it is opt-in on purpose:
 * reading the numbers by hand must never quietly double-count a week in
 * PostHog. Printing is the default because a human runs this to LOOK at it.
 *
 * Questions it CANNOT answer are printed as `n/a (PostHog)` rather than left
 * out. A question quietly dropped is how a zero gets mistaken for a
 * measurement — see memory/analytics.md.
 */
import { PrismaClient } from '@prisma/client';
import { AnalyticsService } from '../src/common/analytics/analytics.service';

type Args = Record<string, string>;

/** Cohorts are weeks in Vietnam time, matching the what-if counter's month. */
const TZ = 'Asia/Ho_Chi_Minh';

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (match) args[match[1]] = match[2] ?? 'true';
  }
  return args;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

type Row = Record<string, string | number | null>;

function printTable(title: string, rows: Row[]): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  if (rows.length === 0) {
    console.log('   (no rows)');
    return;
  }
  const columns = Object.keys(rows[0]);
  const width = (column: string) =>
    Math.max(
      column.length,
      ...rows.map((row) => String(row[column] ?? '—').length),
    );
  const widths = Object.fromEntries(columns.map((c) => [c, width(c)]));
  console.log(
    '   ' + columns.map((c) => c.padEnd(widths[c])).join('  '),
  );
  for (const row of rows) {
    console.log(
      '   ' +
        columns
          .map((c) => String(row[c] ?? '—').padEnd(widths[c]))
          .join('  '),
    );
  }
}

function printCsv(title: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  console.log(`# ${title}`);
  console.log(columns.join(','));
  for (const row of rows) {
    console.log(columns.map((c) => String(row[c] ?? '')).join(','));
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const weeks = Number(args.weeks ?? 8);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) {
    fail('--weeks must be between 1 and 104');
  }
  const csv = args.csv === 'true';
  const push = args.push === 'true';

  /**
   * Sent as ONE event per section rather than one per row: a section is the
   * answer to a question, and PostHog charts a named series over time far
   * better than it charts a table that was printed once and lost.
   */
  const analytics = push ? new AnalyticsService() : null;
  if (push && !analytics?.['client']) {
    fail('--push needs POSTHOG_API_KEY (and NODE_ENV must not be "test")');
  }

  const pushed: string[] = [];
  const failed: string[] = [];

  /**
   * Run one section, and let it fail alone.
   *
   * Learned the hard way: a missing column took the whole report down after
   * five sections had already printed. A weekly report is eight independent
   * questions, and seven answers are worth having when the eighth cannot be
   * asked — a schema that has not caught up yet is a normal state on staging
   * or on a checkout that has not migrated.
   */
  const section = async (
    title: string,
    query: () => Promise<Row[]>,
  ): Promise<void> => {
    let rows: Row[];
    try {
      rows = await query();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The first line only: a Prisma error carries a stack and a query dump,
      // and the point here is "this one is unavailable", not a debug session.
      console.error(
        `\n── ${title}\n   n/a — ${reason.split('\n').find(Boolean)?.trim()}`,
      );
      failed.push(title.split(' ')[0]);
      return;
    }
    emit(title, rows);
  };

  const emit = (title: string, rows: Row[]) => {
    (csv ? printCsv : printTable)(title, rows);
    if (!analytics) return;

    // The metric code (`M2`) is the stable handle; the prose after it is for a
    // human reading the terminal and may be reworded without breaking a chart.
    const code = title.split(' ')[0].toLowerCase();
    analytics.captureSystem('metrics_weekly', {
      metric: code,
      metric_title: title,
      row_count: rows.length,
      rows,
    });
    pushed.push(code);
  };

  // Our own accounts, excluded from every figure below.
  const internal = (process.env.ANALYTICS_INTERNAL_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const prisma = new PrismaClient();

  try {
    // M1 — households created per week, and how many started a trial.
    // The trial is opt-in from the paywall, so this is a real ratio rather
    // than the constant it would be if creation granted one.
    await section('M1 · Households created', () => prisma.$queryRaw<Row[]>`
      SELECT to_char(date_trunc('week', h.created_at AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS week,
             count(*)::int                          AS households,
             count(s.trial_started_at)::int         AS trials_started
      FROM households h
      LEFT JOIN household_subscriptions s ON s.household_id = h.id
      WHERE h.deleted_at IS NULL
        AND h.created_at >= now() - (${weeks} * interval '1 week')
        AND (${internal.length} = 0 OR h.created_by::text <> ALL(${internal}))
      GROUP BY 1 ORDER BY 1 DESC`
    );

    // M2 — the activation metric: did a second person actually arrive?
    // `deleted_at IS NULL` matters — leaving a space soft-deletes the row, so
    // without it a household someone left still counts as two.
    await section('M2 · Households with a second member', () => prisma.$queryRaw<Row[]>`
      SELECT to_char(date_trunc('week', h.created_at AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS week,
             count(*)::int                                        AS households,
             count(*) FILTER (WHERE m.live >= 2)::int             AS with_partner,
             round(100.0 * count(*) FILTER (WHERE m.live >= 2) / nullif(count(*), 0), 1) AS pct
      FROM households h
      JOIN LATERAL (
        SELECT count(*) AS live FROM household_members m
        WHERE m.household_id = h.id AND m.deleted_at IS NULL
      ) m ON true
      WHERE h.deleted_at IS NULL
        AND h.created_at >= now() - (${weeks} * interval '1 week')
        AND (${internal.length} = 0 OR h.created_by::text <> ALL(${internal}))
      GROUP BY 1 ORDER BY 1 DESC`
    );

    // M4 — freshness, from the journal rather than `assets.updated_at`: the
    // daily price cron touches that column, which would make every household
    // holding gold look freshly updated. `actor_id IS NOT NULL` is what
    // separates a person from the cron.
    //
    // Caveat worth reading with the number: routine income/expense money
    // events are deliberately never journalled (audit.types.ts), so a
    // household that only records spending looks quieter than it is.
    await section('M4 · Households with a human write in 30 days', () => prisma.$queryRaw<Row[]>`
      SELECT count(*)::int                                                    AS households_30d_old,
             count(*) FILTER (WHERE last_write >= now() - interval '30 days')::int AS active,
             round(100.0 * count(*) FILTER (WHERE last_write >= now() - interval '30 days')
                   / nullif(count(*), 0), 1)                                  AS pct
      FROM (
        SELECT h.id, max(a.created_at) AS last_write
        FROM households h
        LEFT JOIN audit_logs a ON a.household_id = h.id AND a.actor_id IS NOT NULL
        WHERE h.deleted_at IS NULL
          AND h.created_at < now() - interval '30 days'
          AND (${internal.length} = 0 OR h.created_by::text <> ALL(${internal}))
        GROUP BY h.id
      ) t`
    );

    // M5 — what a household actually holds. A median, not a mean: one
    // household with forty assets would otherwise describe everyone.
    await section('M5 · What a household holds (median)', () => prisma.$queryRaw<Row[]>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY assets)::numeric(10,1)  AS median_assets,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY goals)::numeric(10,1)   AS median_active_goals,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY upcoming)::numeric(10,1) AS median_upcoming
      FROM (
        SELECT h.id,
          (SELECT count(*) FROM assets a
            WHERE a.household_id = h.id AND a.deleted_at IS NULL)          AS assets,
          (SELECT count(*) FROM financial_goals g
            WHERE g.household_id = h.id AND g.deleted_at IS NULL
              AND g.status = 'active')                                      AS goals,
          (SELECT count(*) FROM cashflow_events c
            WHERE c.household_id = h.id AND c.deleted_at IS NULL)          AS upcoming
        FROM households h
        WHERE h.deleted_at IS NULL
          AND (${internal.length} = 0 OR h.created_by::text <> ALL(${internal}))
      ) t`
    );

    // M11 — plan mix. Under 40% yearly is the signal that the saving is not
    // legible enough (09 §9).
    await section('M11 · Paid orders by plan', () => prisma.$queryRaw<Row[]>`
      SELECT plan_code,
             count(*)::int    AS orders,
             sum(amount)::int AS revenue_vnd
      FROM payment_orders
      WHERE status = 'paid' AND paid_at >= now() - (${weeks} * interval '1 week')
      GROUP BY 1 ORDER BY 2 DESC`
    );

    // M9 — which wall converted. NULL means the checkout was opened from the
    // plans page with nothing refused, which is a real answer.
    // PayOS only: a store purchase arrives as a webhook with no order we
    // created, so its reason is not recoverable server-side.
    await section('M9 · Paid orders by paywall reason (PayOS only)', () => prisma.$queryRaw<Row[]>`
      SELECT coalesce(from_reason, '(none)') AS from_reason,
             count(*)::int                   AS orders,
             sum(amount)::int                AS revenue_vnd
      FROM payment_orders
      WHERE status = 'paid' AND paid_at >= now() - (${weeks} * interval '1 week')
      GROUP BY 1 ORDER BY 2 DESC`
    );

    // M13 — campaigns. `campaign` is the attribution field on a code.
    await section('M13 · Activation codes by campaign', () => prisma.$queryRaw<Row[]>`
      SELECT c.campaign,
             count(*)::int                          AS redemptions,
             count(DISTINCT r.household_id)::int    AS households
      FROM redeem_code_redemptions r
      JOIN redeem_codes c ON c.id = r.redeem_code_id
      WHERE r.redeemed_at >= now() - (${weeks} * interval '1 week')
      GROUP BY 1 ORDER BY 2 DESC`
    );

    // M10 — the conversion the trial exists for. Counted from households whose
    // trial has actually ended, so an in-flight trial is not scored as a loss.
    await section('M10 · Trial → paid within 7 days', () => prisma.$queryRaw<Row[]>`
      SELECT count(*)::int AS trials_ended,
             count(*) FILTER (WHERE converted)::int AS converted,
             round(100.0 * count(*) FILTER (WHERE converted) / nullif(count(*), 0), 1) AS pct
      FROM (
        SELECT s.household_id,
               EXISTS (
                 SELECT 1 FROM payment_orders o
                 WHERE o.household_id = s.household_id AND o.status = 'paid'
                   AND o.paid_at >= s.trial_ends_at - interval '7 days'
               ) AS converted
        FROM household_subscriptions s
        JOIN households h ON h.id = s.household_id AND h.deleted_at IS NULL
        WHERE s.trial_ends_at IS NOT NULL
          AND s.trial_ends_at < now() - interval '7 days'
          AND s.trial_ends_at > now() - interval '60 days'
          AND (${internal.length} = 0 OR h.created_by::text <> ALL(${internal}))
      ) t`
    );

    if (!csv) {
      console.log(`
── Not answerable from Postgres ─────────────────────────────
   Does anyone hit a ceiling?      n/a (PostHog · paywall_hit)
   How soon do they hit it?        n/a (PostHog · paywall_hit)
   Weekly retention                n/a (PostHog · app_opened)
   What-if runs per household      n/a (PostHog · what_if_run)
   Store revenue by paywall reason n/a (RevenueCat has no order of ours)

   A quota hit throws and persists nothing, and the what-if counter is a
   Redis key with a month's TTL — deliberately never a table. These are
   listed so a missing number reads as "not measured here", not as zero.
`);
    }
  } finally {
    // Flush BEFORE disconnecting and before the process exits: posthog-node
    // batches in memory, and a CLI that returns immediately would drop the
    // whole week's numbers without a word.
    if (failed.length > 0) {
      // Named, not silent: a section that could not run must not look like a
      // section whose answer was zero.
      console.error(
        `\nunavailable this run: ${failed.join(', ')} — see the reasons above`,
      );
    }
    if (analytics) {
      await analytics.flush();
      await analytics.onApplicationShutdown();
      console.log(`\npushed to PostHog: ${pushed.join(', ')}`);
    }
    await prisma.$disconnect();
  }
}

void main();
