DROP INDEX "payments_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "idempotency_key";