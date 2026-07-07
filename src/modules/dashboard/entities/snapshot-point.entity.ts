export interface SnapshotPoint {
  id: string;
  householdId: string;
  date: string;
  usableNow: number;
  notImmediatelyUsable: number;
  longTerm: number;
  totalDebt: number;
  attentionCount: number;
}
