import { DEFAULT_HOUSEHOLD_TZ } from '../../../common/utils/clock';

/** `YYYY-MM-DD` of an instant, in Vietnam time. */
export function vnIsoDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_HOUSEHOLD_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
