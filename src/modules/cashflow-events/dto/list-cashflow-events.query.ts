export interface ListCashflowEventsQuery {
  /** `incoming` | `outgoing` */
  direction?: string;
  /** A `CashflowEventStatus`, or `live` for everything that still owes money. */
  status?: string;
  /** `required` | `planned` */
  requirement?: string;
  /** `confirmed` | `estimated` */
  certainty?: string;
  /** Inclusive ISO date bounds on `expectedDate`. */
  from?: string;
  to?: string;
  limit?: string;
}
