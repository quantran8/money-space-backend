import {
  freeEntitlement,
  premiumEntitlement,
} from '../../billing/test-support/entitlement.fixture';
import { freeOwnedSpaces } from './space-quota';

describe('freeOwnedSpaces', () => {
  const spaces = [
    { id: 'a', createdBy: 'me' },
    { id: 'b', createdBy: 'me' },
    { id: 'c', createdBy: 'partner' },
    { id: 'd', createdBy: 'me' },
  ];

  it('counts only Free spaces the user created', () => {
    const entitlements = new Map([
      ['a', freeEntitlement({ householdId: 'a' })],
      ['b', premiumEntitlement({ householdId: 'b' })],
      ['c', freeEntitlement({ householdId: 'c' })],
      ['d', freeEntitlement({ householdId: 'd' })],
    ]);
    expect(
      freeOwnedSpaces(spaces, 'me', entitlements).map((s) => s.id),
    ).toEqual(['a', 'd']);
  });

  it('treats a lapsed Premium space as Free', () => {
    const entitlements = new Map([
      ['a', premiumEntitlement({ householdId: 'a', status: 'expired' })],
      ['b', premiumEntitlement({ householdId: 'b' })],
      ['d', premiumEntitlement({ householdId: 'd' })],
    ]);
    expect(
      freeOwnedSpaces(spaces, 'me', entitlements).map((s) => s.id),
    ).toEqual(['a']);
  });
});
