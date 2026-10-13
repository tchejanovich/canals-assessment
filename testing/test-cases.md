## Run the automated suite

Start the API, load the SQL test data, and set `DATABASE_URL` to the test
database. The runner also requires `curl`, `jq`, and `psql`; it initializes the
fixture stock and reports each case as it runs.

```bash
export DATABASE_URL='postgres://user:password@localhost:5432/canals'
BASE_URL='http://localhost:3000' ./testing/run-test-cases.sh
```

`BASE_URL` is optional and defaults to `http://localhost:3000`. The runner
generates a fresh `RUN_ID` for each invocation. It exits with status `0` when all
checks pass and `1` when one or more checks fail.

## Testing cases

The examples below use the five standalone fixture products and warehouses from
the SQL test-data setup. They require `curl`, `jq`, and `psql`, with
`DATABASE_URL` set in the shell. Re-run the setup with a new `RUN_ID` for a fresh
pass. Run the commands in the same Bash session. Setup initializes a generous
stock baseline once; ordinary stock cases can run sequentially. The exact-stock
and race cases are stateful, so reset inventory only before repeating those
specific cases. Idempotency replays intentionally return the previously recorded
result rather than creating another order.

### Test setup

```bash
BASE_URL=http://localhost:3000
RUN_ID="$(date +%s)-$$"

read -r GLUE_ID PVC90_ID NO_STOCK_ID RMC_ID INACTIVE_ID < <(
  psql "$DATABASE_URL" -XAt -F ' ' -c "
    SELECT
      (SELECT id FROM products WHERE sku = 'PVC-GLUE-QT'),
      (SELECT id FROM products WHERE sku = 'PVC-90-150'),
      (SELECT id FROM products WHERE sku = 'PVC-LB-075'),
      (SELECT id FROM products WHERE sku = 'RMC-075'),
      (SELECT id FROM products WHERE sku = 'BREAKER-2P-40A');
  "
)

BASE_BODY=$(jq -nc --argjson glue "$GLUE_ID" '{
  customer: {name:"Taylor", email:"taylor@example.com", phone:"+1 305 555 0201"},
  address: {
    line1:"101 NW 1st Ave", line2:null, city:"Miami", region:"FL",
    postalCode:"33130", country:"US"
  },
  items: [{productId:$glue, quantity:1}],
  creditCardNumber:"4242424242424242"
}')

# Each call sends one curl POST. Pass an idempotency key to make successful
# examples safely replayable; omit it for the no-key case.
curl_order() {
  local body="$1"
  local key="${2:-}"
  local -a args=(-sS -i -X POST "$BASE_URL/orders" -H 'Content-Type: application/json')
  if [[ -n "$key" ]]; then
    args+=(-H "Idempotency-Key: $key")
  fi
  curl "${args[@]}" --data "$body"
}

reset_stock() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO inventory (warehouse_id, product_id, quantity)
SELECT w.id, p.id, v.quantity
FROM (VALUES
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
) AS v(warehouse_name, sku, quantity)
JOIN warehouses w ON w.name = v.warehouse_name
JOIN products p ON p.sku = v.sku
ON CONFLICT (warehouse_id, product_id)
DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now();
SQL
}

reset_stock

LONG_LINE=$(printf '%201s' '' | tr ' ' x)
```

Successful POSTs return the order object with `state: "active"`, customer,
warehouse, shipping address, line items, totals, and creation time. IDs and
timestamps vary. Error bodies use
`{"statusCode":N,"error":"...","message":"..."}`; validation errors also
include an `errors` array with the invalid field paths.

### Invalid input

- **Reject a blank, non-letter, or overlong customer name.** Run each variant:

  ```bash
  curl_order "$(jq -c '.customer.name = ""' <<<"$BASE_BODY")"
  curl_order "$(jq -c '.customer.name = "Taylor Lee"' <<<"$BASE_BODY")"
  curl_order "$(jq -c --arg n "$(printf 'A%.0s' {1..101})' '.customer.name = $n' <<<"$BASE_BODY")"
  ```

  Expected: `400`; `message` is `Validation failed`, with an error path of
  `customer.name`.

- **Reject a malformed customer email or a non-string phone number.**

  ```bash
  curl_order "$(jq -c '.customer.email = "not-an-email"' <<<"$BASE_BODY")"
  curl_order "$(jq -c '.customer.phone = 123' <<<"$BASE_BODY")"
  ```

  Expected: `400`; validation error paths are `customer.email` and
  `customer.phone`, respectively.

- **Reject missing or blank required address fields.**

  ```bash
  curl_order "$(jq -c '.address |= del(.city)' <<<"$BASE_BODY")"
  curl_order "$(jq -c '.address.line1 = "" | .address.city = "" | .address.postalCode = ""' <<<"$BASE_BODY")"
  ```

  Expected: `400`; `message` is `Validation failed`, with errors for the blank
  address fields.

- **Reject an overlong optional address line 2.**

  ```bash
  curl_order "$(jq -c --arg line2 "$LONG_LINE" '.address.line2 = $line2' <<<"$BASE_BODY")"
  ```

  Expected: `400`; the validation error path is `address.line2`.

- **Reject region and country codes that are not exactly two characters.**

  ```bash
  curl_order "$(jq -c '.address.region = "F" | .address.country = "USA"' <<<"$BASE_BODY")"
  ```

  Expected: `400`; validation errors identify `address.region` and
  `address.country`.

- **Reject an empty or oversized order item list.**

  ```bash
  curl_order "$(jq -c '.items = []' <<<"$BASE_BODY")"
  curl_order "$(jq -c '.items = [range(0;101) | {productId:(10000 + .),quantity:1}]' <<<"$BASE_BODY")"
  ```

  Expected: `400`; the `items` field violates its minimum or maximum length.

- **Reject non-positive or non-integer product IDs and quantities.**

  ```bash
  curl_order "$(jq -c '.items = [{productId:0,quantity:1.5}]' <<<"$BASE_BODY")"
  ```

  Expected: `400`; validation errors identify `items.0.productId` and
  `items.0.quantity`.

- **Reject quantities above the supported maximum.**

  ```bash
  curl_order "$(jq -c '.items[0].quantity = 1000001' <<<"$BASE_BODY")"
  ```

  Expected: `400`; the validation error path is `items.0.quantity`.

- **Reject a credit card number that is not 13–19 digits.**

  ```bash
  curl_order "$(jq -c '.creditCardNumber = "123456789012"' <<<"$BASE_BODY")"
  ```

  Expected: `400`; the validation error path is `creditCardNumber`.

### Customers and addresses

- **Place an order for a new customer with a new address.** The run-specific
  email and address keep this case repeatable.

  ```bash
  NEW_BODY=$(jq -c --arg email "new${RUN_ID}@example.com" --arg line1 "700 Test ${RUN_ID} Ave" \
    '.customer = {name:"Avery",email:$email,phone:"+1 305 555 0299"} | .address.line1 = $line1' <<<"$BASE_BODY")
  curl_order "$NEW_BODY" "${RUN_ID}-new-customer"
  ```

  Expected: `201`; an active order for customer `Avery`, with the new shipping
  address and the selected fulfilling warehouse.

- **Place an order for an existing customer with matching email, name, and phone.**

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-existing-customer"
  ```

  Expected: `201`; an active order whose customer is Taylor
  (`taylor@example.com`).

- **Match an existing customer when the email casing differs.**

  ```bash
  curl_order "$(jq -c '.customer.email = "TAYLOR@EXAMPLE.COM"' <<<"$BASE_BODY")" "${RUN_ID}-email-case"
  ```

  Expected: `201`; the response customer email is normalized to
  `taylor@example.com`.

- **Reject an existing customer email with a mismatched name.**

  ```bash
  curl_order "$(jq -c '.customer.name = "Jordan"' <<<"$BASE_BODY")"
  ```

  Expected: `409` with `{"statusCode":409,"error":"Conflict","message":"Name does not match the existing customer for email taylor@example.com"}`.

- **Reject an existing customer email with a mismatched phone.**

  ```bash
  curl_order "$(jq -c '.customer.phone = "+1 305 555 9999"' <<<"$BASE_BODY")"
  ```

  Expected: `409` with `{"statusCode":409,"error":"Conflict","message":"Phone does not match the existing customer for email taylor@example.com"}`.

- **Reuse an existing address when its fields match after case and whitespace normalization.**

  ```bash
  NORMALIZED_ADDRESS_BODY=$(jq -c '.address.line1 = " 101 nw 1st ave " | .address.city = " MIAMI " | .address.region = "fl" | .address.country = "us"' <<<"$BASE_BODY")
  curl_order "$NORMALIZED_ADDRESS_BODY" "${RUN_ID}-normalized-address"
  ```

  Expected: `201`; the response contains the order with the submitted address
  fields trimmed. The address ID is not returned by the API; verify the address
  fingerprint is still represented by one row:

  ```sql
  SELECT count(*) FROM addresses
  WHERE fingerprint = '["101 nw 1st ave","","miami","fl","33130","us"]';
  ```

- **Create a distinct address when a normalized address field differs.**

  ```bash
  DIFFERENT_ADDRESS_BODY=$(jq -c --arg line1 "102 NW ${RUN_ID} Ave" '.address.line1 = $line1' <<<"$BASE_BODY")
  curl_order "$DIFFERENT_ADDRESS_BODY" "${RUN_ID}-different-address"
  ```

  Expected: `201`; the response shipping address has the new `line1` value.
  The run-specific address can be checked with:

  ```bash
  psql "$DATABASE_URL" -XAt -c "SELECT count(*) FROM addresses WHERE line1 = '102 NW ${RUN_ID} Ave';"
  ```

- **Reuse an address across different customers.**

  ```bash
  JORDAN_AT_TAYLOR_ADDRESS=$(jq -c '.customer = {name:"Jordan",email:"jordan@example.com",phone:"+1 305 555 0202"}' <<<"$BASE_BODY")
  curl_order "$JORDAN_AT_TAYLOR_ADDRESS" "${RUN_ID}-shared-address"
  ```

  Expected: `201`; the order response contains customer Jordan and Taylor's
  shipping address.

- **Reject an unknown country or region.**

  ```bash
  curl_order "$(jq -c '.address.country = "ZZ"' <<<"$BASE_BODY")"
  curl_order "$(jq -c '.address.region = "ZZ"' <<<"$BASE_BODY")"
  ```

  Expected: `400`; the respective messages are `Unknown country ZZ` and
  `Unknown region ZZ`.

- **Avoid persisting a new customer or address when no warehouse can fulfill the order.**

  ```bash
  NO_STOCK_BODY=$(jq -c --arg email "nostock${RUN_ID}@example.com" --arg line1 "800 No Stock ${RUN_ID} Ave" \
    --argjson noStock "$NO_STOCK_ID" --argjson glue "$GLUE_ID" \
    '.customer = {name:"Avery",email:$email,phone:"+1 305 555 0299"} | .address.line1 = $line1 | .items = [{productId:$glue,quantity:1},{productId:$noStock,quantity:1}]' \
    <<<"$BASE_BODY")
  curl_order "$NO_STOCK_BODY" "${RUN_ID}-no-warehouse"
  ```

  Expected: `422` with `{"statusCode":422,"error":"Unprocessable Entity","message":"No single warehouse can fulfil the entire order"}`. Verify that neither record was persisted:

  ```sql
  SELECT
    (SELECT count(*) FROM customers WHERE email = 'nostock<RUN_ID>@example.com') AS customers,
    (SELECT count(*) FROM addresses WHERE line1 = '800 No Stock <RUN_ID> Ave') AS addresses;
  ```

  Both counts should be zero; substitute the value of `RUN_ID` from the setup.

### Stock and warehouse selection

- **Place an order when a warehouse has exactly the requested stock.**

  ```bash
  curl_order "$(jq -c --argjson pvc90 "$PVC90_ID" '.items = [{productId:$pvc90,quantity:100}]' <<<"$BASE_BODY")" "${RUN_ID}-exact-stock"
  ```

  Expected: `201`; an active order assigned to `Miami Closest`, with quantity
  `100` and total amount `120000` minor units. This consumes Miami Closest's
  exact PVC 90 stock; run `reset_stock` before repeating this case.

- **Reject an order when requested stock exceeds availability.**

  ```bash
  curl_order "$(jq -c '.items[0].quantity = 501' <<<"$BASE_BODY")"
  ```

  Expected: `422` with `No single warehouse can fulfil the entire order`; the
  greatest glue stock at any one fixture warehouse is `500`.

- **Place an order containing a stocked product and a product with no stock.**

  ```bash
  curl_order "$(jq -c --argjson noStock "$NO_STOCK_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$noStock,quantity:1}]' <<<"$BASE_BODY")"
  ```

  Expected: `422` with `No single warehouse can fulfil the entire order`.

- **Place a multi-product order when one warehouse has every requested product.**

  ```bash
  curl_order "$(jq -c --argjson pvc90 "$PVC90_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$pvc90,quantity:1}]' <<<"$BASE_BODY")" "${RUN_ID}-multi-product"
  ```

  Expected: `201`; an active order assigned to `Miami Backup` (the closest
  remaining warehouse with both items), with both line items and total amount
  `2050` minor units.

- **Reject a multi-product order when its products are stocked only across different warehouses.**

  ```bash
  curl_order "$(jq -c --argjson pvc90 "$PVC90_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:250},{productId:$pvc90,quantity:250}]' <<<"$BASE_BODY")"
  ```

  Expected: `422` with `No single warehouse can fulfil the entire order`.

- **Select the nearest warehouse that can fulfill every requested product.**

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-nearest"
  ```

  Expected: `201`; the response warehouse is `Miami Closest`, whose coordinates
  match the stored coordinates for the Taylor shipping address.

- **Fall back to a farther warehouse when the nearest candidate loses stock before reservation.** This requires coordinating the database row lock with the request; a free-running parallel curl cannot guarantee the race window.

  ```bash
  reset_stock
  ```

  In a separate `psql` session, lock the nearest warehouse's glue row:

  ```sql
  BEGIN;
  SELECT i.id
  FROM inventory i
  JOIN warehouses w ON w.id = i.warehouse_id
  JOIN products p ON p.id = i.product_id
  WHERE w.name = 'Miami Closest' AND p.sku = 'PVC-GLUE-QT'
  FOR UPDATE OF i;
  ```

  While that transaction remains open, run this curl from another terminal.
  After the request is waiting on the inventory row lock, set that row to zero
  and commit the `psql` transaction:

  ```sql
  SELECT pid, wait_event_type, query
  FROM pg_stat_activity
  WHERE wait_event_type = 'Lock' AND query ILIKE '%inventory%';
  ```

  Confirm the order request is waiting before running the update below.

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-fallback"
  ```

  ```sql
  UPDATE inventory i
  SET quantity = 0
  FROM warehouses w, products p
  WHERE i.warehouse_id = w.id AND i.product_id = p.id
    AND w.name = 'Miami Closest' AND p.sku = 'PVC-GLUE-QT';
  COMMIT;
  ```

  Expected: `201`; the response warehouse is `Miami Backup` and the order is
  `active`.

- **Record a race loss when every candidate loses stock before reservation.** This also needs the database-lock coordination described above; it cannot be made deterministic with an uncoordinated curl alone.

  ```bash
  reset_stock
  ```

  In `psql`, lock the three warehouses that have glue stock, then run the curl
  while the transaction is open. Once the request is waiting on a row lock, set
  all three quantities to zero and commit.

  ```sql
  BEGIN;
  SELECT i.id
  FROM inventory i
  JOIN warehouses w ON w.id = i.warehouse_id
  JOIN products p ON p.id = i.product_id
  WHERE w.name IN ('Miami Closest', 'Miami Backup', 'Orlando Stock')
    AND p.sku = 'PVC-GLUE-QT'
  FOR UPDATE OF i;
  ```

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-all-candidates-race"
  ```

  Confirm with the `pg_stat_activity` query above that the request is waiting
  on a lock before zeroing the stock.

  ```sql
  UPDATE inventory i
  SET quantity = 0
  FROM warehouses w, products p
  WHERE i.warehouse_id = w.id AND i.product_id = p.id
    AND w.name IN ('Miami Closest', 'Miami Backup', 'Orlando Stock')
    AND p.sku = 'PVC-GLUE-QT';
  COMMIT;
  ```

  Expected: `409`; the response message includes the recorded order ID and says
  it is in state `created`, with no stock reserved or payment charged.

### Product and payment cases

The race demonstration leaves fixture glue stock depleted. Restore the baseline
once before continuing with product, payment, and idempotency cases:

```bash
reset_stock
```

- **Reject an order for an inactive product or nonexistent product ID.**

  ```bash
  curl_order "$(jq -c --argjson inactive "$INACTIVE_ID" '.items = [{productId:$inactive,quantity:1}]' <<<"$BASE_BODY")"
  curl_order "$(jq -c '.items[0].productId = 999999999' <<<"$BASE_BODY")"
  ```

  Expected: `400` with `Product <id> is not available` for the inactive product;
  `404` with `Product 999999999 not found` for the unknown ID.

- **Reject duplicate product IDs and mixed-currency orders.**

  ```bash
  curl_order "$(jq -c --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$glue,quantity:2}]' <<<"$BASE_BODY")"
  curl_order "$(jq -c --argjson rmc "$RMC_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$rmc,quantity:1}]' <<<"$BASE_BODY")"
  ```

  Expected: `400`; duplicate items return a validation error for `items`, and
  mixed currencies return `All products in an order must share the same currency`.

- **Activate an order and decrement stock after successful payment.**

  ```bash
  curl_order "$(jq -c --argjson pvc90 "$PVC90_ID" '.items = [{productId:$pvc90,quantity:1}]' <<<"$BASE_BODY")" "${RUN_ID}-paid"
  ```

  Expected: `201`; the order response has `state: "active"`, currency `USD`,
  and the requested line item. Miami Closest's PVC 90 quantity is decremented
  from `100` to `99`:

  ```sql
  SELECT i.quantity
  FROM inventory i
  JOIN warehouses w ON w.id = i.warehouse_id
  JOIN products p ON p.id = i.product_id
  WHERE w.name = 'Miami Closest' AND p.sku = 'PVC-90-150';
  ```

- **Cancel an order and restore reserved stock after payment is declined.**

  ```bash
  curl_order "$(jq -c '.creditCardNumber = "4242424242420000"' <<<"$BASE_BODY")" "${RUN_ID}-decline"
  ```

  Expected: `402` with `{"statusCode":402,"error":"Payment Required","message":"Payment was declined"}`. The order is cancelled and the reserved stock is restored. With the baseline inventory, Miami Closest's glue quantity should be back at `100`:

  ```sql
  SELECT i.quantity
  FROM inventory i
  JOIN warehouses w ON w.id = i.warehouse_id
  JOIN products p ON p.id = i.product_id
  WHERE w.name = 'Miami Closest' AND p.sku = 'PVC-GLUE-QT';
  ```

### Idempotency and retrieval

- **Replay a matching request with the same idempotency key.**

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-replay"
  curl_order "$BASE_BODY" "${RUN_ID}-replay"
  ```

  Expected: the first response is `201`; the second is `200`. Both contain the
  same order ID and order body; stock is reserved only once.

- **Reject reuse of an idempotency key with a changed payload.**

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-changed-payload"
  curl_order "$(jq -c '.items[0].quantity = 2' <<<"$BASE_BODY")" "${RUN_ID}-changed-payload"
  ```

  Expected: `201` followed by `409` with
  `Idempotency key <key> was already used with a different payload`.

- **Replay the same idempotency key concurrently.**

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-concurrent-key" >"/tmp/order-a-${RUN_ID}.txt" &
  PID_A=$!
  curl_order "$BASE_BODY" "${RUN_ID}-concurrent-key" >"/tmp/order-b-${RUN_ID}.txt" &
  PID_B=$!
  wait "$PID_A" "$PID_B"
  cat "/tmp/order-a-${RUN_ID}.txt" "/tmp/order-b-${RUN_ID}.txt"
  ```

  Expected: one `201` and one `200`; both response bodies have the same order
  ID. Re-running with a new `RUN_ID` creates a new test key.

- **Submit identical requests without an idempotency key.**

  ```bash
  curl_order "$BASE_BODY"
  curl_order "$BASE_BODY"
  ```

  Expected: both responses are `201` with different order IDs; these are two
  distinct orders and stock is decremented twice.

- **Replay an idempotency key for an order with a recorded payment decline.**

  ```bash
  DECLINED_BODY=$(jq -c '.creditCardNumber = "4242424242420000"' <<<"$BASE_BODY")
  curl_order "$DECLINED_BODY" "${RUN_ID}-declined-replay"
  curl_order "$DECLINED_BODY" "${RUN_ID}-declined-replay"
  ```

  Expected: both responses are `402`. The first message is `Payment was
declined`; the replay says the order was recorded as `cancelled` and reserved
  stock was restored.

- **Retrieve an order with its customer, warehouse, and line-item details.**

  ```bash
  curl_order "$BASE_BODY" "${RUN_ID}-retrieve"
  read -r -p 'Enter the order ID from the response: ' ORDER_ID
  curl -i "$BASE_URL/orders/$ORDER_ID"
  ```

  Expected: the POST is `201`; the GET is `200` and returns the stored order
  object, including customer, selected warehouse, shipping address, and items.

- **Retrieve an order using an unknown order ID.**

  ```bash
  curl -i "$BASE_URL/orders/999999999999"
  ```

  Expected: `404` with
  `{"statusCode":404,"error":"Not Found","message":"Order 999999999999 not found"}`.
