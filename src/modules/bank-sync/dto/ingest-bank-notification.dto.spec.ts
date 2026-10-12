import { parseIngestBody } from './ingest-bank-notification.dto';

const VALID = {
  clientEventId: '550E8400-E29B-41D4-A716-446655440000',
  app: 'VCB Digibank',
  title: 'Thông báo VCB',
  body: 'Số dư TK VCB …',
  notificationAt: '2026-10-12T14:44:34+07:00',
};

describe('parseIngestBody', () => {
  it('accepts the Shortcuts payload and lowercases the UUID', () => {
    const dto = parseIngestBody(VALID);
    expect(dto.clientEventId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(dto.notificationAt?.toISOString()).toBe('2026-10-12T07:44:34.000Z');
  });

  it.each(['userId', 'accountId', 'bankCode', 'householdId'])(
    'rejects a client-supplied %s',
    (key) => {
      expect(() => parseIngestBody({ ...VALID, [key]: 'x' })).toThrow(key);
    },
  );

  it('rejects a malformed clientEventId', () => {
    expect(() => parseIngestBody({ ...VALID, clientEventId: 'abc' })).toThrow();
  });

  it('accepts a payload without clientEventId', () => {
    const { clientEventId: _omit, ...rest } = VALID;
    void _omit;
    expect(parseIngestBody(rest).clientEventId).toBeNull();
  });

  it('enforces length caps', () => {
    expect(() =>
      parseIngestBody({ ...VALID, body: 'x'.repeat(3001) }),
    ).toThrow();
  });

  it('drops an unparseable notification date instead of rejecting', () => {
    expect(
      parseIngestBody({ ...VALID, notificationAt: 'hôm nay' }).notificationAt,
    ).toBeNull();
  });
});
