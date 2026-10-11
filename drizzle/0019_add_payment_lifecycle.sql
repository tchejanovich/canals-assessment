CREATE TYPE "public"."payment_status" AS ENUM('authorizing', 'authorized', 'captured', 'voided');--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "external_id" TO "authorization_id";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "authorization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "status" "payment_status" DEFAULT 'authorizing' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "capture_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "payments_external_id_idx";--> statement-breakpoint
CREATE INDEX "payments_authorization_id_idx" ON "payments" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key_unique" ON "payments" USING btree ("idempotency_key");
