INSERT INTO "customers" ("name", "email", "phone")
VALUES
	('Taylor', 'taylor@example.com', '+1 305 555 0201'),
	('Jordan', 'jordan@example.com', '+1 305 555 0202'),
	('Morgan', 'morgan@example.com', '+1 305 555 0203'),
	('Riley', 'riley@example.com', '+1 305 555 0204'),
	('Casey', 'casey@example.com', '+1 305 555 0205');--> statement-breakpoint

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
	c."id",
	v."latitude",
	v."longitude"
FROM "countries" c
JOIN (
	VALUES
		('Miami Closest', '200 Fixture Ave', 'Miami', 'FL', '33130', 25.761700::numeric, -80.191800::numeric),
		('Miami Backup', '202 Fixture Rd', 'Doral', 'FL', '33122', 25.817000::numeric, -80.300000::numeric),
		('Orlando Stock', '303 Fixture St', 'Orlando', 'FL', '32801', 28.538300::numeric, -81.379200::numeric),
		('Austin Stock', '404 Fixture Blvd', 'Austin', 'TX', '78701', 30.267200::numeric, -97.743100::numeric),
		('Los Angeles Empty', '505 Fixture Way', 'Los Angeles', 'CA', '90015', 34.040700::numeric, -118.269200::numeric)
) AS v("name", "line1", "city", "region_code", "postal_code", "latitude", "longitude")
	ON true
JOIN "regions" r
	ON r."country_id" = c."id" AND r."code" = v."region_code"
WHERE c."code" = 'US';--> statement-breakpoint

INSERT INTO "products" ("sku", "name", "price_amount", "currency", "active")
VALUES
	('PVC-GLUE-QT', 'Big can of PVC glue', 850, 'USD', true),
	('PVC-90-150', '1 ½" PVC 90', 1200, 'USD', true),
	('PVC-LB-075', '¾" PVC LB''s', 300, 'USD', true),
	('RMC-075', '1000'' 3/4" RMC', 700, 'EUR', true),
	('BREAKER-2P-40A', '6 - 2 pole 40-amp circuit breakers', 900, 'USD', false);--> statement-breakpoint

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
	cst."id",
	v."line1",
	v."city",
	r."id",
	v."postal_code",
	c."id",
	v."latitude",
	v."longitude",
	v."fingerprint"
FROM (
	VALUES
		('taylor@example.com', '101 NW 1st Ave', 'Miami', 'FL', '33130', 25.761700::numeric, -80.191800::numeric, '["101 nw 1st ave","","miami","fl","33130","us"]'),
		('jordan@example.com', '202 Sample Rd', 'Doral', 'FL', '33122', 25.817000::numeric, -80.300000::numeric, '["202 sample rd","","doral","fl","33122","us"]'),
		('morgan@example.com', '303 Mock St', 'Orlando', 'FL', '32801', 28.538300::numeric, -81.379200::numeric, '["303 mock st","","orlando","fl","32801","us"]'),
		('riley@example.com', '404 Demo Blvd', 'Austin', 'TX', '78701', 30.267200::numeric, -97.743100::numeric, '["404 demo blvd","","austin","tx","78701","us"]'),
		('casey@example.com', '505 Fixture Way', 'Los Angeles', 'CA', '90015', 34.040700::numeric, -118.269200::numeric, '["505 fixture way","","los angeles","ca","90015","us"]')
) AS v("email", "line1", "city", "region_code", "postal_code", "latitude", "longitude", "fingerprint")
JOIN "customers" cst ON cst."email" = v."email"
JOIN "countries" c ON c."code" = 'US'
JOIN "regions" r
	ON r."country_id" = c."id" AND r."code" = v."region_code";--> statement-breakpoint

INSERT INTO "inventory" ("warehouse_id", "product_id", "quantity")
SELECT w."id", p."id", v."quantity"
FROM (
	VALUES
		('Miami Closest', 'PVC-GLUE-QT', 100),
		('Miami Closest', 'PVC-90-150', 100),
		('Miami Backup', 'PVC-GLUE-QT', 200),
		('Miami Backup', 'PVC-90-150', 200),
		('Orlando Stock', 'PVC-GLUE-QT', 500),
		('Orlando Stock', 'PVC-90-150', 0),
		('Austin Stock', 'PVC-GLUE-QT', 0),
		('Austin Stock', 'PVC-90-150', 500),
		('Los Angeles Empty', 'PVC-GLUE-QT', 0),
		('Los Angeles Empty', 'PVC-90-150', 0)
) AS v("warehouse_name", "sku", "quantity")
JOIN "warehouses" w ON w."name" = v."warehouse_name"
JOIN "products" p ON p."sku" = v."sku";
