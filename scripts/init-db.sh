#!/usr/bin/env bash
#
# Initialize the database schema on the configured database.
#
# The Prisma datasource `url` points at DIRECT_URL (see prisma/schema.prisma),
# so this applies prisma/schema.prisma straight to the remote (Supabase) DB.
#
# What it does:
#   - Runs `prisma db push` to make the database match prisma/schema.prisma.
#   - Does NOT seed data and does NOT drop anything (unless --accept-data-loss).
#
# Usage:
#   npm run db:init                      # apply schema to the DB (DIRECT_URL)
#   npm run db:init:dry                  # preview the SQL diff only (no writes)
#   npm run db:init -- --accept-data-loss   # allow destructive drops
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ .env not found at $ENV_FILE" >&2
  echo "  Copy .env.example to .env and fill in DIRECT_URL first." >&2
  exit 1
fi

# Read DIRECT_URL from .env only to show a masked sanity line (Prisma itself
# also loads .env). Not sourcing the file avoids executing arbitrary lines.
DIRECT_URL="$(
  grep -E '^[[:space:]]*DIRECT_URL[[:space:]]*=' "$ENV_FILE" \
    | tail -n 1 \
    | sed -E 's/^[[:space:]]*DIRECT_URL[[:space:]]*=[[:space:]]*//; s/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//'
)"

if [[ -z "${DIRECT_URL:-}" ]]; then
  echo "✗ DIRECT_URL is not set in .env" >&2
  exit 1
fi

MASKED="$(printf '%s' "$DIRECT_URL" | sed -E 's#(://[^:]+:)[^@]+@#\1***@#')"
echo "→ Target database: $MASKED"

DRY=0
PUSH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run)    DRY=1 ;;
    *)                  PUSH_ARGS+=("$arg") ;;
  esac
done

if [[ "$DRY" -eq 1 ]]; then
  echo "→ Dry run: previewing schema diff (no changes will be written)..."
  npx prisma migrate diff \
    --from-url "$DIRECT_URL" \
    --to-schema-datamodel prisma/schema.prisma \
    --script
  exit 0
fi

echo "→ Applying schema with 'prisma db push'..."
npx prisma db push "${PUSH_ARGS[@]}"

echo "✓ Database schema is up to date."
