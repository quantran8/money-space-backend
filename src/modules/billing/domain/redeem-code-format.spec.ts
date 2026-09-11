import {
  CODE_ALPHABET,
  formatRedeemCode,
  generateRedeemCode,
  generateRedeemCodes,
  isValidRedeemCode,
  normalizeRedeemCode,
} from './redeem-code-format';

describe('normalizeRedeemCode', () => {
  it('strips separators and upper-cases', () => {
    expect(normalizeRedeemCode('ours-8k3m-2qyt')).toBe('OURS8K3M2QYT');
  });

  it('strips the whitespace and zero-width characters a chat paste carries', () => {
    expect(normalizeRedeemCode('  OURS 8K3M​2QYT\n')).toBe('OURS8K3M2QYT');
  });

  /**
   * The reason this product uses Crockford at all: codes arrive as a screenshot
   * in a Zalo message and are typed by hand, so someone entering the letter
   * they SEE still has to match the code that was stored.
   */
  it('folds the confusable characters a person would type from an image', () => {
    // Letter O → 0, letter I and L → 1, U → V — in the BODY.
    expect(normalizeRedeemCode('OURS-O1I2-3456')).toBe('OURS01123456');
    expect(normalizeRedeemCode('OURSLLLL1234')).toBe('OURS11111234');
  });

  /**
   * `OURS` contains two of the letters the fold rewrites. Folding the whole
   * string would turn every code into `0VRS…`, matching nothing.
   */
  it('leaves the prefix alone', () => {
    expect(normalizeRedeemCode('OURS8K3M2QYT').startsWith('OURS')).toBe(true);
  });

  it('handles empty and junk input without throwing', () => {
    expect(normalizeRedeemCode('')).toBe('');
    expect(normalizeRedeemCode('!!!')).toBe('');
  });
});

describe('isValidRedeemCode', () => {
  it('accepts a freshly generated code', () => {
    expect(isValidRedeemCode(generateRedeemCode())).toBe(true);
  });

  it('accepts a generated code after a round trip through display form', () => {
    const code = generateRedeemCode();
    expect(isValidRedeemCode(normalizeRedeemCode(formatRedeemCode(code)))).toBe(
      true,
    );
  });

  it('rejects anything without the prefix', () => {
    expect(isValidRedeemCode('ABCD8K3M2QYT')).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isValidRedeemCode('OURS8K3M')).toBe(false);
    expect(isValidRedeemCode('OURS8K3M2QYTX')).toBe(false);
  });

  it('rejects characters outside the alphabet', () => {
    // `I` never survives normalization, so a raw code containing one is invalid.
    expect(isValidRedeemCode('OURSI8K3M2QY')).toBe(false);
  });

  /**
   * The point of the check character: a single typo is caught in the client,
   * costing no request and no rate-limit attempt.
   */
  it('rejects a single mistyped character almost always', () => {
    const code = generateRedeemCode();
    let caught = 0;
    let tried = 0;

    // Vary one body character at a time to every other alphabet letter.
    for (let index = 4; index < code.length - 1; index += 1) {
      for (const char of CODE_ALPHABET) {
        if (char === code[index]) continue;
        tried += 1;
        const typo = code.slice(0, index) + char + code.slice(index + 1);
        if (!isValidRedeemCode(typo)) caught += 1;
      }
    }

    // 31 of every 32 wrong characters land on a different checksum.
    expect(caught / tried).toBeGreaterThan(0.95);
  });
});

describe('formatRedeemCode', () => {
  it('groups a valid code for display', () => {
    expect(formatRedeemCode('OURS01123456')).toBe('OURS-0112-3456');
  });

  it('returns malformed input untouched rather than mangling it', () => {
    expect(formatRedeemCode('nonsense')).toBe('nonsense');
  });
});

describe('generateRedeemCode', () => {
  it('produces a code that is valid and correctly shaped', () => {
    const code = generateRedeemCode();

    expect(code).toHaveLength(12);
    expect(code.startsWith('OURS')).toBe(true);
    expect(isValidRedeemCode(code)).toBe(true);
  });

  it('never emits a character outside the alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const body = generateRedeemCode().slice(4);
      for (const char of body) expect(CODE_ALPHABET).toContain(char);
    }
  });

  it('survives its own normalization — a generated code is already canonical', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRedeemCode();
      expect(normalizeRedeemCode(code)).toBe(code);
    }
  });
});

describe('generateRedeemCodes', () => {
  it('returns the requested count, all distinct and all valid', () => {
    const codes = generateRedeemCodes(500);

    expect(codes).toHaveLength(500);
    expect(new Set(codes).size).toBe(500);
    expect(codes.every(isValidRedeemCode)).toBe(true);
  });

  it('returns nothing for a count of zero', () => {
    expect(generateRedeemCodes(0)).toEqual([]);
  });
});
