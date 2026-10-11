INSERT INTO "customers" ("name", "email", "phone")
VALUES ('Tomas', 'tomas.chejanovich@example.com', '+1 305 555 0142');--> statement-breakpoint
INSERT INTO "addresses" (
	"customer_id",
	"line1",
	"city",
	"region_id",
	"postal_code",
	"country_id",
	"latitude",
	"longitude",
	"fingerprint"
)
SELECT
	c."id",
	'100 SW 1st Ave',
	'Miami',
	r."id",
	'33130',
	co."id",
	25.761700,
	-80.191800,
	'tomas|100 sw 1st ave|miami|fl|33130|us'
FROM "customers" c
JOIN "countries" co ON co."code" = 'US'
JOIN "regions" r ON r."country_id" = co."id" AND r."code" = 'FL'
WHERE c."email" = 'tomas.chejanovich@example.com';--> statement-breakpoint
INSERT INTO "warehouses" (
	"name",
	"line1",
	"city",
	"region_id",
	"postal_code",
	"country_id",
	"latitude",
	"longitude"
)
SELECT
	v."name",
	v."line1",
	v."city",
	r."id",
	v."postal_code",
	co."id",
	v."latitude",
	v."longitude"
FROM "countries" co
JOIN "regions" r ON r."country_id" = co."id"
JOIN (
	VALUES
		('Miami Central', '200 NW 21st St', 'Miami', 'FL', '33127', 25.795700, -80.199000),
		('Miami Doral', '8505 NW 27th St', 'Doral', 'FL', '33122', 25.816600, -80.337700),
		('Orlando', '600 W Amelia St', 'Orlando', 'FL', '32801', 28.545100, -81.389800),
		('Los Angeles', '1200 S Figueroa St', 'Los Angeles', 'CA', '90015', 34.040700, -118.269200),
		('Austin', '500 E 5th St', 'Austin', 'TX', '78701', 30.267200, -97.739700)
) AS v("name", "line1", "city", "region_code", "postal_code", "latitude", "longitude")
	ON v."region_code" = r."code"
WHERE co."code" = 'US';--> statement-breakpoint
INSERT INTO "products" ("sku", "name", "price_amount", "currency")
VALUES
	('PVC150', 'CONDUIT PVC 1-1/2" SCHEDULE 40', 1200, 'USD'),
	('PVCCEMENTQT', 'CEMENT PVC CONDUIT QT #99 7210603 CANTEX', 850, 'USD');--> statement-breakpoint
INSERT INTO "inventory" ("warehouse_id", "product_id", "quantity")
SELECT w."id", p."id", 100
FROM "warehouses" w
CROSS JOIN "products" p
WHERE w."name" = 'Miami Central' AND p."sku" = 'PVC150';
