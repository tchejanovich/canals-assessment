DROP INDEX "orders_status_idx";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."order_status";