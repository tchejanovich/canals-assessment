CREATE TABLE "warehouses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region_id" bigint NOT NULL,
	"postal_code" text NOT NULL,
	"country_id" bigint NOT NULL,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warehouses_coordinates_idx" ON "warehouses" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "warehouses_country_id_idx" ON "warehouses" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX "warehouses_region_id_idx" ON "warehouses" USING btree ("region_id");--> statement-breakpoint
CREATE TRIGGER warehouses_set_updated_at BEFORE UPDATE ON "warehouses" FOR EACH ROW EXECUTE FUNCTION set_updated_at();