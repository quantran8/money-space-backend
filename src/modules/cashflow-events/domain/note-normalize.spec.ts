import { normalizeNote, phraseMatches, phrasesOverlap } from './note-normalize';

describe('normalizeNote', () => {
  it('strips Vietnamese diacritics, đ, case and punctuation', () => {
    expect(normalizeNote('  Lương  tháng 10 - Công ty ĐẠI Việt. ')).toBe(
      'LUONG THANG 10 CONG TY DAI VIET',
    );
  });

  it('turns null/empty into an empty string', () => {
    expect(normalizeNote(null)).toBe('');
    expect(normalizeNote(' .. ')).toBe('');
  });
});

describe('phraseMatches', () => {
  const note = normalizeNote('MBVCB.123.LUONG T10 CTY ABC.CT tu 0071');

  it('matches a phrase on whole tokens', () => {
    expect(phraseMatches(note, normalizeNote('luong t10 cty abc'))).toBe(true);
  });

  it('does not match inside a longer token', () => {
    expect(phraseMatches(normalizeNote('LUONGVAN A'), 'LUONG')).toBe(false);
  });

  it('never matches an empty phrase or note', () => {
    expect(phraseMatches(note, '')).toBe(false);
    expect(phraseMatches('', 'LUONG')).toBe(false);
  });

  it('flags overlap in either direction', () => {
    expect(phrasesOverlap('THANH TOAN', 'THANH TOAN DIEN')).toBe(true);
    expect(phrasesOverlap('TIEN NHA', 'TIEN DIEN')).toBe(false);
  });
});
