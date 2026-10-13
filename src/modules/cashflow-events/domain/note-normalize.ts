// Note-rule normalisation and matching. See memory/cashflow-settlement.md.

export const MIN_PHRASE_LENGTH = 4;

export function normalizeNote(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `contains` on whole tokens, so `LUONG` does not hit `LUONGVAN`. */
export function phraseMatches(
  normalizedNote: string,
  normalizedPhrase: string,
): boolean {
  if (!normalizedNote || !normalizedPhrase) return false;
  return ` ${normalizedNote} `.includes(` ${normalizedPhrase} `);
}

export function phrasesOverlap(a: string, b: string): boolean {
  return phraseMatches(a, b) || phraseMatches(b, a);
}
