export interface CreateSnapshotDto {
  /** Snapshot date (YYYY-MM-DD). Defaults to AS_OF. */
  snapshotDate?: string;
  note?: string;
}
