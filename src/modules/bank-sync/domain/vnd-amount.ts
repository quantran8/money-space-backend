/**
 * Parse a VND amount written with thousand separators ("2,190,538", "2.000",
 * "500"). Returns null for anything with a decimal part or mixed separators,
 * so a reference or account number is never read as money.
 */
export function parseVndAmount(raw: string): number | null {
  const text = raw.trim();
  if (/^\d{1,3}(,\d{3})+$/.test(text) || /^\d{1,3}(\.\d{3})+$/.test(text)) {
    return Number(text.replace(/[.,]/g, ''));
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  return null;
}
