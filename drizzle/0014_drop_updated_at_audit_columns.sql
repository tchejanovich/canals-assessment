DROP TRIGGER IF EXISTS customers_set_updated_at ON "customers";--> statement-breakpoint
DROP TRIGGER IF EXISTS countries_set_updated_at ON "countries";--> statement-breakpoint
DROP TRIGGER IF EXISTS regions_set_updated_at ON "regions";--> statement-breakpoint
DROP TRIGGER IF EXISTS products_set_updated_at ON "products";--> statement-breakpoint
DROP TRIGGER IF EXISTS warehouses_set_updated_at ON "warehouses";--> statement-breakpoint
DROP TRIGGER IF EXISTS addresses_set_updated_at ON "addresses";--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_set_updated_at ON "orders";--> statement-breakpoint
DROP FUNCTION IF EXISTS set_updated_at();--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "countries" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "regions" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "warehouses" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "addresses" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "updated_at";