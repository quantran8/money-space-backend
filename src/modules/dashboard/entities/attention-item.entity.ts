export type AttentionLevel = 'normal' | 'important' | 'urgent';

export interface AttentionItem {
  id: string;
  householdId: string;
  title: string;
  reason: string;
  level: AttentionLevel;
}
