CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
DROP INDEX "warehouses_coordinates_idx";--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "location" geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude"::double precision, "latitude"::double precision), 4326)::geography) STORED;--> statement-breakpoint
CREATE INDEX "warehouses_location_gist_idx" ON "warehouses" USING gist ("location");
