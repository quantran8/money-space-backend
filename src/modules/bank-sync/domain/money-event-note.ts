/** Money-event note from the stored bank-event description. See memory/bank-sync.md. */
export function moneyEventNote(
  providerCode: string | null,
  description: string | null,
): string {
  const text = (description ?? '').trim();
  if (providerCode === 'TECHCOMBANK') {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    return (lines.at(-1) ?? '')
      .replace(/[.\s]*M[aã]\s+tham\s+chi[eế]u\b.*$/iu, '')
      .trim();
  }
  if (providerCode === 'VCB') {
    // Content sits between `Ref <code>.` and the `FT…` trace string.
    const content = /\bRef\s+[^\s.]+\.?\s*([\s\S]*)$/u.exec(text)?.[1];
    if (content === undefined) return text;
    return content.replace(/\s*\bFT\d{6,}[\s\S]*$/u, '').trim();
  }
  return text;
}
