/**
 * RFC 4180 CSV, with one addition Excel needs.
 *
 * See `memory/data-export.md` for why the export is CSV at all and why the BOM
 * is not optional here.
 */

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Excel on Windows reads a BOM-less UTF-8 file as the local ANSI codepage, so
 * "Tiền điện" arrives as "Tiá»n Ä‘iá»‡n". Vietnamese names are the whole point
 * of the file, so the BOM leads every export.
 */
export const UTF8_BOM = '﻿';

/** CRLF: RFC 4180's line ending, and the one Excel is happiest with. */
const ROW_SEPARATOR = '\r\n';

/**
 * Quote a single field.
 *
 * A leading `=`, `+`, `-` or `@` makes Excel and Sheets treat the cell as a
 * FORMULA, so a name someone typed can execute on open. Prefixing a tab
 * neutralises it while still displaying the original text — the household's own
 * data must survive a round trip, so escaping beats stripping.
 */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';

  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `\t${text}`;
  }

  // Quote when the text carries a delimiter, a quote, or a newline — and
  // double any quote inside, which is how RFC 4180 escapes one.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function csvRow(values: CsvValue[]): string {
  return values.map(csvField).join(',');
}

/** A complete sheet: header row, then one row per record, BOM-led. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return (
    UTF8_BOM +
    [csvRow(headers), ...rows.map(csvRow)].join(ROW_SEPARATOR) +
    ROW_SEPARATOR
  );
}
