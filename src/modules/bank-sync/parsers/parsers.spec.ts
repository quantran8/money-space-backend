import { providerForApp } from './parser-registry';
import { TechcombankParser } from './techcombank.parser';
import { VcbParser } from './vcb.parser';

// Fabricated account numbers and amounts only.
const objectContaining = (value: object): unknown =>
  expect.objectContaining(value);
const TCB_IN = {
  title: '+ VND 2,000',
  body: [
    'Tài khoản: 1903 1234 5678 01',
    'Số dư: VND 2,190,538',
    'NGUYEN VAN A chuyen tien den TK 9988776655',
  ].join('\n'),
};

const VCB_IN = {
  title: 'Thông báo VCB',
  body: 'Số dư TK VCB 0123456789 +2,000 VND lúc 12-10-2026 14:44:34. Số dư 24,056,118 VND. Ref EXAMPLE123 chuyen tien 500,000',
};

describe('TechcombankParser', () => {
  const parser = new TechcombankParser();

  it('reads amount from the title, never the balance', () => {
    const result = parser.parse(TCB_IN);
    expect(result).toEqual({
      ok: true,
      reviewReason: undefined,
      event: objectContaining({
        providerCode: 'TECHCOMBANK',
        accountNumber: '19031234567801',
        amountMinor: 2000,
        direction: 'IN',
        reportedBalanceMinor: 2190538,
        transactionAt: null,
        parserVersion: 'tcb@1',
      }),
    });
  });

  it('ignores account numbers in the description', () => {
    const result = parser.parse(TCB_IN);
    expect(result.ok && result.event.accountNumber).toBe('19031234567801');
  });

  it('flags OUT for review until a real sample is verified', () => {
    const result = parser.parse({ ...TCB_IN, title: '- VND 500,000' });
    expect(result.ok && result.event.direction).toBe('OUT');
    expect(result.ok && result.reviewReason).toBe('OUT_UNVERIFIED');
  });

  it('fails closed when the title carries no amount', () => {
    const result = parser.parse({ ...TCB_IN, title: 'Thông báo' });
    expect(result).toMatchObject({ ok: false, status: 'PARSE_FAILED' });
  });

  it('rejects a decimal amount', () => {
    const result = parser.parse({ ...TCB_IN, title: '+ VND 2,000.50' });
    expect(result.ok).toBe(false);
  });

  it('leaves the account empty when it is masked', () => {
    const result = parser.parse({
      ...TCB_IN,
      body: 'Tài khoản: 1903xxxx5678\nSố dư: VND 2,190,538',
    });
    expect(result.ok && result.event.accountNumber).toBeNull();
  });

  it('sends two different account lines to review', () => {
    const result = parser.parse({
      ...TCB_IN,
      body: 'Tài khoản: 1903123456\nTài khoản: 1903999999',
    });
    expect(result).toMatchObject({ ok: false, status: 'REVIEW' });
  });

  it('matches decomposed Vietnamese text', () => {
    const result = parser.parse({
      ...TCB_IN,
      body: TCB_IN.body.normalize('NFD'),
    });
    expect(result.ok && result.event.accountNumber).toBe('19031234567801');
  });
});

describe('VcbParser', () => {
  const parser = new VcbParser();

  it('reads amount, account, balance and Vietnam-time timestamp', () => {
    const result = parser.parse(VCB_IN);
    expect(result).toEqual({
      ok: true,
      reviewReason: undefined,
      event: objectContaining({
        providerCode: 'VCB',
        accountNumber: '0123456789',
        amountMinor: 2000,
        direction: 'IN',
        reportedBalanceMinor: 24056118,
        externalReference: null,
      }),
    });
    expect(result.ok && result.event.transactionAt?.toISOString()).toBe(
      '2026-10-12T07:44:34.000Z',
    );
  });

  it('never takes the balance as the amount', () => {
    const result = parser.parse(VCB_IN);
    expect(result.ok && result.event.amountMinor).not.toBe(24056118);
  });

  it('flags OUT for review', () => {
    const result = parser.parse({
      ...VCB_IN,
      body: VCB_IN.body.replace('+2,000', '-150,000'),
    });
    expect(result.ok && result.event).toMatchObject({
      direction: 'OUT',
      amountMinor: 150000,
    });
    expect(result.ok && result.reviewReason).toBe('OUT_UNVERIFIED');
  });

  it('fails closed on a truncated message', () => {
    const result = parser.parse({
      ...VCB_IN,
      body: 'Số dư TK VCB 0123456789 +2,000',
    });
    expect(result).toMatchObject({ ok: false, status: 'PARSE_FAILED' });
  });

  it('rejects an impossible date', () => {
    const result = parser.parse({
      ...VCB_IN,
      body: VCB_IN.body.replace('12-10-2026', '31-02-2026'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'TIME_INVALID' });
  });

  it('tolerates line breaks inside the body', () => {
    const result = parser.parse({
      ...VCB_IN,
      body: VCB_IN.body.replace(' lúc ', '\nlúc '),
    });
    expect(result.ok).toBe(true);
  });
});

describe('providerForApp', () => {
  it.each([
    ['Techcombank', 'TECHCOMBANK'],
    ['VCB Digibank', 'VCB'],
    ['  vcb   digibank ', 'VCB'],
    ['Zalo', null],
  ])('%s → %s', (app, expected) => {
    expect(providerForApp(app)).toBe(expected);
  });
});

describe('isBalanceMovement', () => {
  const tcb = new TechcombankParser();
  const vcb = new VcbParser();
  const PROMO = {
    title: 'Tài khoản thưởng đã được kích hoạt lại',
    body: 'Tiếp tục khám phá các ưu đãi hấp dẫn Techcombank dành tặng bạn nhé',
  };

  it('accepts real balance movements', () => {
    expect(tcb.isBalanceMovement(TCB_IN)).toBe(true);
    expect(vcb.isBalanceMovement(VCB_IN)).toBe(true);
  });

  it('rejects promo and system messages', () => {
    expect(tcb.isBalanceMovement(PROMO)).toBe(false);
    expect(
      vcb.isBalanceMovement({ title: 'VCB', body: 'Nhận ngay ưu đãi 50,000 VND khi mở thẻ' }),
    ).toBe(false);
  });

  it('keeps a reformatted movement that still carries the balance line', () => {
    expect(
      tcb.isBalanceMovement({ title: 'Biến động số dư', body: TCB_IN.body }),
    ).toBe(true);
  });
});
