export type UpdateFrequency = 'weekly' | 'monthly' | 'manual';

export interface Household {
  id: string;
  name: string;
  currency: string;
  updateFrequency: UpdateFrequency;
  createdBy: string;
  createdAt: string;
}
