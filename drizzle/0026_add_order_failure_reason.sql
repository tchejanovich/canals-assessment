ALTER TABLE "orders" ADD COLUMN "failure_reason" text;--> statement-breakpoint
UPDATE "orders" SET "state" = 'failed', "failure_reason" = 'stock_reservation' WHERE "state" = 'created';--> statement-breakpoint
UPDATE "orders" SET "failure_reason" = 'payment' WHERE "state" = 'failed' AND "failure_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_failure_reason_valid" CHECK ("orders"."failure_reason" IS NULL OR "orders"."failure_reason" IN ('payment', 'stock_reservation'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_failure_reason_state_consistent" CHECK (("orders"."state" = 'failed' AND "orders"."failure_reason" IS NOT NULL) OR ("orders"."state" <> 'failed' AND "orders"."failure_reason" IS NULL));
