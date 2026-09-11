import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'rawResponse';

/**
 * Return the handler's value verbatim, without the `{ success, data, … }`
 * envelope every other route gets.
 *
 * For endpoints whose response shape is dictated by someone else. The PayOS
 * webhook is the case this exists for: PayOS decides what a successful
 * acknowledgement looks like, and wrapping it in our envelope would leave the
 * fields it checks nested one level too deep — so it would treat every
 * delivery as failed and retry it forever.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
