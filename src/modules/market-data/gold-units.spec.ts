import {
  GOLD_QUOTE_UNIT,
  GOLD_UNITS,
  goldPricesByUnit,
  convertGoldPricePerUnit,
  isConvertibleGoldUnit,
  normalizeGoldUnit,
} from './gold-units';

describe('gold units', () => {
  const perLuong = 12_000_000;

  it('leaves a per-lượng quote alone', () => {
    expect(convertGoldPricePerUnit(perLuong, 'lượng')).toBe(perLuong);
  });

  it('divides by ten for chỉ', () => {
    expect(convertGoldPricePerUnit(perLuong, 'chỉ')).toBe(1_200_000);
  });

  it('divides by 37.5 for gram', () => {
    expect(convertGoldPricePerUnit(perLuong, 'gram')).toBe(320_000);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(convertGoldPricePerUnit(perLuong, '  CHỈ ')).toBe(1_200_000);
  });

  // A record saved before the unit picker existed can carry anything; the
  // dealer's own figure beats a guessed divisor.
  it('returns the price unchanged for an unknown unit', () => {
    expect(convertGoldPricePerUnit(perLuong, 'ounce')).toBe(perLuong);
  });

  it('reports which units it can restate into', () => {
    expect(isConvertibleGoldUnit('gram')).toBe(true);
    expect(isConvertibleGoldUnit('ounce')).toBe(false);
  });

  it('normalizes to the dealers’ unit when none is given', () => {
    expect(normalizeGoldUnit(undefined)).toBe(GOLD_QUOTE_UNIT);
    expect(normalizeGoldUnit('ounce')).toBe(GOLD_QUOTE_UNIT);
    expect(normalizeGoldUnit(' Gram ')).toBe('gram');
  });
});

describe('goldPricesByUnit', () => {
  it('states one per-lượng figure in every unit gold is held in', () => {
    expect(goldPricesByUnit(12_000_000)).toEqual({
      chỉ: 1_200_000,
      lượng: 12_000_000,
      gram: 320_000,
    });
  });

  it('covers exactly the units the form offers', () => {
    expect(Object.keys(goldPricesByUnit(1))).toEqual(GOLD_UNITS);
  });
});
