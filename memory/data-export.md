# Data export

Handing the household a copy of their own data. Related:
[[billing-and-entitlement]], [[assets]], [[money-events]], [[cashflow-events]],
[[goals]], [[debts]].

## Overview

`GET /households/:householdId/export?format=json|csv&dataset=<name>`

Gated by `@RequirePremium('export_data')` — the boolean has existed in
`PLAN_LIMITS` and in `EntitlementGuard` since Phase 1; Phase 5 is the route
that finally uses it.

Two formats, for two different readers:

- **JSON** (the default) — everything at once, relationships intact, with an
  `exportedAt` stamp and a `formatVersion`. This is the one that is a *record*:
  a file found on a disk in a year says what it is and when it was taken.
- **CSV** — one dataset per file (`assets`, `money-events`, `cashflow-events`,
  `goals`, `debts`), for someone who wants it in a spreadsheet. Five files
  rather than one, because a single CSV holding five different shapes is not a
  spreadsheet anyone can use.

## Rules

- **Soft-deleted rows are left out.** The export is what the household currently
  has, not an audit trail. `deleted_at IS NULL` on every read.
- **Headers are English machine names** (`current_value`, not "Giá trị"). A
  spreadsheet that gets re-imported has to match on something stable, and the
  client owns all display copy anyway.
- **Dates are ISO.** Date-only where the column is a date (`event_date`), full
  timestamps where it is a timestamp. `Decimal` is converted to a number at the
  repository, because `Decimal` does not survive `JSON.stringify`.
- **`@RawResponse()`** — a downloaded file has to *be* the file. The usual
  `{ success, data }` envelope would make the CSV unopenable and the JSON export
  a payload nested inside another one.
- **`Cache-Control: no-store`** — the browser must not hold a copy of somebody's
  finances, and a re-export after an edit has to return the new data.

## Two CSV details that are not optional

**The UTF-8 BOM.** Excel on Windows reads a BOM-less UTF-8 file as the local
ANSI codepage, so "Tiền điện" arrives as "Tiá»n Ä‘iá»‡n". Vietnamese names are
the entire point of the file, so the BOM leads every export.

**Formula injection.** A cell beginning `=`, `+`, `-` or `@` is a FORMULA to
Excel and Sheets, so a note someone typed can execute when the file is opened.
Every such field is prefixed with a tab, which neutralises it while still
displaying the original text — the household's own data must survive a round
trip, so escaping beats stripping.

Note the consequence: a negative amount renders as `\t-1500`, not `-1500`.
Spreadsheets still read it as a number; it is the leading position that makes a
minus sign dangerous, and the rule cannot distinguish "-1500" from "-1+cmd()"
without parsing, which is the thing that gets this wrong.

## The filename is transliterated

`oursight-gia-dinh-minh-2026-09-07.json`.

`Content-Disposition` travels through headers that are latin-1, so
"Gia đình Minh" would arrive mangled or split the header. The household name is
NFD-normalised, combining marks stripped, `đ/Đ` folded (it is a distinct letter
and survives decomposition), then slugged to ASCII. A name that transliterates
to nothing falls back to `household`.

## Not streamed, deliberately

The whole household is held in memory. A file the household downloads has to be
complete before it is a record of anything, and the biggest realistic household
is a few thousand rows. If that stops being true, `exportJson` is the method
that grows a cursor — nothing else has to change.

## Its own module

`ExportModule` imports no domain module. An export is one read across every
table, and hanging it off Assets or Money Events would put a cross-domain read
inside a module that owns one of them. It does not import Billing either: the
gate is `@RequirePremium`, enforced globally from `AuthModule`.
