ALTER TABLE "orders" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "state" SET DATA TYPE text USING "state"::text;--> statement-breakpoint
DROP TYPE "public"."order_state";--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('created', 'reserved', 'active', 'failed');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "state" SET DATA TYPE "public"."order_state" USING (
	CASE
		WHEN "state" = 'cancelled' THEN 'failed'
		ELSE "state"
	END
)::"public"."order_state";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "state" SET DEFAULT 'created'::"public"."order_state";
