-- AlterTable
ALTER TABLE "bank_notification_events" ADD COLUMN     "counterpart_source_id" UUID,
ADD COLUMN     "transfer_peer_event_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "bank_notification_events_transfer_peer_event_id_key" ON "bank_notification_events"("transfer_peer_event_id");

-- CreateIndex
CREATE INDEX "bank_notification_events_counterpart_idx" ON "bank_notification_events"("household_id", "counterpart_source_id");

-- AddForeignKey
ALTER TABLE "bank_notification_events" ADD CONSTRAINT "bank_notification_events_counterpart_source_id_fkey" FOREIGN KEY ("counterpart_source_id") REFERENCES "bank_external_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_notification_events" ADD CONSTRAINT "bank_notification_events_transfer_peer_event_id_fkey" FOREIGN KEY ("transfer_peer_event_id") REFERENCES "bank_notification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

