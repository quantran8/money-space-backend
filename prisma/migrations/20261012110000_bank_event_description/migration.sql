-- Notification body (account number masked) used as the money event's note. See memory/bank-sync.md.
ALTER TABLE "bank_notification_events" ADD COLUMN "description" TEXT;
