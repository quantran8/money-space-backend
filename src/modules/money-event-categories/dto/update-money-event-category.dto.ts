import type { CreateMoneyEventCategoryDto } from './create-money-event-category.dto';

// `code` is the stable key money_events rows point at, so it is NOT editable —
// only the label and ordering can change. Renaming a code would orphan every
// event carrying the old code; create a new category and re-tag instead.
export type UpdateMoneyEventCategoryDto = Partial<
  Omit<CreateMoneyEventCategoryDto, 'code'>
>;
