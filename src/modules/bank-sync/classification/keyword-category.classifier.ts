import { Injectable } from '@nestjs/common';
import type { CategoryClassifier, ClassifyInput } from './category-classifier';

type Rule = { code: string; keywords: string[] };

// Keywords are lowercase, accent-free. First matching rule wins, so the more
// specific rules come first.
const OUT_RULES: Rule[] = [
  { code: 'insurance', keywords: ['bao hiem', 'bhxh', 'bhyt', 'bhtn'] },
  { code: 'education', keywords: ['hoc phi', 'khoa hoc', 'udemy', 'tien hoc', 'sach vo'] },
  { code: 'health', keywords: ['benh vien', 'phong kham', 'nha khoa', 'nha thuoc', 'tien thuoc', 'mua thuoc', 'vien phi'] },
  { code: 'travel', keywords: ['ve may bay', 'khach san', 'booking', 'agoda', 'vietjet', 'vietnam airlines', 'bamboo airways', 'du lich', 'resort'] },
  { code: 'transport', keywords: ['grab', 'xanh sm', 'gojek', 'be bike', 'taxi', 'do xang', 'xang', 'gui xe', 'cao toc', 'etoll', 've xe', 'petrolimex'] },
  { code: 'housing', keywords: ['tien nha', 'thue nha', 'tien dien', 'tien nuoc', 'internet', 'wifi', 'chung cu', 'phi quan ly', 'evn'] },
  { code: 'repair', keywords: ['sua chua', 'sua xe', 'sua nha'] },
  { code: 'saving', keywords: ['tiet kiem'] },
  { code: 'investment', keywords: ['chung khoan', 'mua co phieu', 'ssi', 'vps', 'tcbs', 'vndirect'] },
  { code: 'debt', keywords: ['tra no', 'tra gop', 'tra lai vay', 'tat toan'] },
  { code: 'children', keywords: ['hoc phi con', 'tien con', 'sua cho be', 'ta cho be'] },
  { code: 'family_support', keywords: ['bieu ba me', 'gui ba me', 'gui bo me', 'ho tro gia dinh'] },
  { code: 'food_drink', keywords: ['an sang', 'an trua', 'an toi', 'an uong', 'cafe', 'ca phe', 'tra sua', 'nha hang', 'quan an', 'highlands', 'starbucks', 'grabfood', 'shopeefood', 'banh mi', 'tra da'] },
  { code: 'household', keywords: ['shopee', 'lazada', 'tiki', 'tap hoa', 'bach hoa xanh', 'winmart', 'coopmart', 'circle k', 'di cho', 'sieu thi'] },
];

const IN_RULES: Rule[] = [
  { code: 'interest', keywords: ['lai tien gui', 'lai suat', 'tra lai', 'tien lai'] },
  { code: 'income', keywords: ['luong', 'salary', 'thuong', 'bonus', 'hoa hong'] },
];

/** Lowercase, drop accents (đ → d), collapse punctuation to single spaces. */
export function normalizeNote(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/giu, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

@Injectable()
export class KeywordCategoryClassifier implements CategoryClassifier {
  classify({ note, direction }: ClassifyInput): Promise<string | null> {
    const text = ` ${normalizeNote(note)} `;
    const rules = direction === 'IN' ? IN_RULES : OUT_RULES;
    for (const rule of rules) {
      if (rule.keywords.some((keyword) => text.includes(` ${keyword} `))) {
        return Promise.resolve(rule.code);
      }
    }
    return Promise.resolve(null);
  }
}
