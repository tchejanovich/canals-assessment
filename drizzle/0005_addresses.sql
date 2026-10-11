CREATE TABLE "addresses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region_id" bigint NOT NULL,
	"postal_code" text NOT NULL,
	"country_id" bigint NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"geocoded_at" timestamp with time zone,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_fingerprint_unique" ON "addresses" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "addresses_coordinates_idx" ON "addresses" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "addresses_country_id_idx" ON "addresses" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX "addresses_region_id_idx" ON "addresses" USING btree ("region_id");--> statement-breakpoint
CREATE TRIGGER addresses_set_updated_at BEFORE UPDATE ON "addresses" FOR EACH ROW EXECUTE FUNCTION set_updated_at();