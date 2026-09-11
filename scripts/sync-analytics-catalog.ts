/**
 * Copy the event catalog into the frontend workspace.
 *
 * The two pnpm workspaces are separate roots — `backend/pnpm-workspace.yaml`
 * has no `packages:` key, and `@money-space/core` ships unbuilt ESM TypeScript
 * with `#/*` self-imports — so the backend genuinely cannot import from core.
 * One authored file plus one generated copy is the honest minimum.
 *
 * It is only two places, not three: `packages/core` is compiled by BOTH the web
 * build and the mobile typecheck, so one generated file serves both clients.
 *
 *   pnpm analytics:sync           # write the copy
 *   pnpm analytics:sync -- --check  # fail if it has drifted (CI)
 *
 * `--check` reports a DIFF rather than a boolean: a human can act on a diff.
 * CI must run `--check` only — this script writes outside its own repo.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SOURCE = resolve(
  __dirname,
  '../src/common/analytics/event-catalog.ts',
);

/** Sibling checkout. Relative, so it survives a clone anywhere. */
const TARGET = resolve(
  __dirname,
  '../../frontend/packages/core/src/shared/analytics/event-catalog.ts',
);

const HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: backend/src/common/analytics/event-catalog.ts
 * Regenerate:     pnpm analytics:sync   (from backend/)
 *
 * The backend and the frontend are separate pnpm workspaces, so this cannot be
 * an import. \`pnpm analytics:sync --check\` fails CI when the two drift.
 */
`;

function render(): string {
  const source = readFileSync(SOURCE, 'utf8');
  return HEADER + source;
}

function main() {
  const check = process.argv.includes('--check');

  if (!existsSync(SOURCE)) {
    console.error(`error: catalog not found at ${SOURCE}`);
    process.exit(1);
  }

  const next = render();

  if (check) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
    if (current === next) {
      console.log('analytics catalog: in sync');
      return;
    }

    console.error('analytics catalog has DRIFTED from the backend.\n');
    const a = current.split('\n');
    const b = next.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.error(`  line ${i + 1}`);
        console.error(`    frontend: ${a[i] ?? '(missing)'}`);
        console.error(`    backend:  ${b[i] ?? '(missing)'}`);
      }
    }
    console.error('\nRun `pnpm analytics:sync` from backend/ to fix.');
    process.exit(1);
  }

  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, next, 'utf8');
  console.log(`analytics catalog → ${TARGET}`);
}

main();
