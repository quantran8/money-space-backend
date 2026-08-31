-- DropForeignKey
ALTER TABLE "goal_asset_allocations" DROP CONSTRAINT "goal_asset_allocations_asset_id_fkey";

-- DropForeignKey
ALTER TABLE "goal_asset_allocations" DROP CONSTRAINT "goal_asset_allocations_created_by_fkey";

-- DropForeignKey
ALTER TABLE "goal_asset_allocations" DROP CONSTRAINT "goal_asset_allocations_financial_goal_id_fkey";

-- DropForeignKey
ALTER TABLE "goal_asset_allocations" DROP CONSTRAINT "goal_asset_allocations_household_id_fkey";

-- DropForeignKey
ALTER TABLE "goal_asset_allocations" DROP CONSTRAINT "goal_asset_allocations_updated_by_fkey";

-- DropForeignKey
ALTER TABLE "snapshot_goal_values" DROP CONSTRAINT "snapshot_goal_values_financial_goal_id_fkey";

-- DropForeignKey
ALTER TABLE "snapshot_goal_values" DROP CONSTRAINT "snapshot_goal_values_household_id_fkey";

-- DropForeignKey
ALTER TABLE "snapshot_goal_values" DROP CONSTRAINT "snapshot_goal_values_snapshot_id_fkey";

-- DropIndex
DROP INDEX "snapshot_goal_values_snapshot_goal_key";

-- AlterTable
ALTER TABLE "goal_asset_allocations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "snapshot_goal_values" ADD CONSTRAINT "snapshot_goal_values_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_goal_values" ADD CONSTRAINT "snapshot_goal_values_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_goal_values" ADD CONSTRAINT "snapshot_goal_values_financial_goal_id_fkey" FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_asset_allocations" ADD CONSTRAINT "goal_asset_allocations_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_asset_allocations" ADD CONSTRAINT "goal_asset_allocations_financial_goal_id_fkey" FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_asset_allocations" ADD CONSTRAINT "goal_asset_allocations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_asset_allocations" ADD CONSTRAINT "goal_asset_allocations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_asset_allocations" ADD CONSTRAINT "goal_asset_allocations_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "snapshot_goal_values_goal_idx" RENAME TO "snapshot_goal_values_financial_goal_id_idx";

-- RenameIndex
ALTER INDEX "snapshot_goal_values_household_snapshot_idx" RENAME TO "snapshot_goal_values_household_id_snapshot_id_idx";
