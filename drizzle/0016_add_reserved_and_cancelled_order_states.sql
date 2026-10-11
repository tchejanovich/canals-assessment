ALTER TYPE "public"."order_state" ADD VALUE 'reserved' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."order_state" ADD VALUE 'cancelled';