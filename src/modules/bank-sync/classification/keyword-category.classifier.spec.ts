import { KeywordCategoryClassifier } from './keyword-category.classifier';

describe('KeywordCategoryClassifier', () => {
  const classifier = new KeywordCategoryClassifier();
  const run = (note: string, direction: 'IN' | 'OUT' = 'OUT') =>
    classifier.classify({ note, direction, providerCode: null });

  it('matches accent-insensitively on whole words', async () => {
    expect(await run('TRAN DINH QUAN do xang')).toBe('transport');
    expect(await run('Thanh toán Bảo hiểm nhân thọ')).toBe('insurance');
    expect(await run('Grab*HCM')).toBe('transport');
  });

  it('files eating out under food_drink', async () => {
    expect(await run('Highlands Coffee ca phe sang')).toBe('food_drink');
    expect(await run('Tien tap hoa')).toBe('household');
  });

  it('does not match inside a longer word', async () => {
    expect(await run('thuongmai')).toBeNull();
  });

  it('uses the inflow rules for IN events', async () => {
    expect(await run('CTY ABC tra luong T10', 'IN')).toBe('income');
    expect(await run('do xang', 'IN')).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    expect(await run('chuyen khoan')).toBeNull();
  });
});
