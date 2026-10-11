CREATE TYPE "public"."order_state" AS ENUM('created', 'active');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "idempotency_request_hash" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "state" "order_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_state_created_at_idx" ON "orders" USING btree ("state","created_at");