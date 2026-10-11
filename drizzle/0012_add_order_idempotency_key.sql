ALTER TABLE "orders" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_unique" ON "orders" USING btree ("idempotency_key");