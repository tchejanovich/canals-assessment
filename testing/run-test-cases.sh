#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the test database connection string}"

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="${RUN_ID:-$(date +%s)-$$}"

for command in curl jq psql; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command not found: %s\n' "$command" >&2
    exit 2
  }
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/canals-tests.XXXXXX")"
RACE_HOLDER_PID=""
cleanup() {
  if [[ -n "$RACE_HOLDER_PID" ]] && kill -0 "$RACE_HOLDER_PID" 2>/dev/null; then
    kill "$RACE_HOLDER_PID" 2>/dev/null || true
    wait "$RACE_HOLDER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PASSED=0
FAILED=0
HTTP_CODE=""
HTTP_BODY=""

pass() {
  PASSED=$((PASSED + 1))
  printf '[PASS] %s (HTTP %s)\n' "$1" "$2"
}

fail() {
  FAILED=$((FAILED + 1))
  printf '[FAIL] %s (expected HTTP %s, got %s)\n' "$1" "$2" "$3" >&2
  if [[ -n "$4" ]]; then
    printf '       Response: %s\n' "$4" >&2
  fi
}

db_scalar() {
  psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1"
}

request_order() {
  local body="$1"
  local key="${2:-}"
  local -a args=(
    -sS
    -X POST
    "$BASE_URL/orders"
    -H 'Content-Type: application/json'
    -o "$TMP_DIR/response.json"
    -w '%{http_code}'
  )
  if [[ -n "$key" ]]; then
    args+=(-H "Idempotency-Key: $key")
  fi
  HTTP_CODE="$(curl "${args[@]}" --data "$body")"
  HTTP_BODY="$(<"$TMP_DIR/response.json")"
}

request_get() {
  HTTP_CODE="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' "$BASE_URL$1")"
  HTTP_BODY="$(<"$TMP_DIR/response.json")"
}

check_response() {
  local name="$1"
  local expected_code="$2"
  local jq_filter="$3"

  if [[ "$HTTP_CODE" != "$expected_code" ]]; then
    fail "$name" "$expected_code" "$HTTP_CODE" "$HTTP_BODY"
  elif jq -e "$jq_filter" <<<"$HTTP_BODY" >/dev/null 2>&1; then
    pass "$name" "$HTTP_CODE"
  else
    fail "$name" "HTTP $expected_code and JSON matching: $jq_filter" "HTTP $HTTP_CODE (JSON mismatch)" "$HTTP_BODY"
  fi
}

check_order() {
  local name="$1"
  local expected_code="$2"
  local jq_filter="$3"
  local body="$4"
  local key="${5:-}"
  request_order "$body" "$key"
  check_response "$name" "$expected_code" "$jq_filter"
}

check_db_value() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name" "DB=$actual"
  else
    fail "$name" "$expected" "$actual" "database assertion failed"
  fi
}

reset_stock() {
  psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<'SQL'
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

request_order_to_files() {
  local body="$1"
  local key="$2"
  local body_file="$3"
  local status_file="$4"
  curl -sS -X POST "$BASE_URL/orders" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $key" \
    -o "$body_file" \
    -w '%{http_code}' \
    --data "$body" >"$status_file"
}

run_controlled_race() {
  local name="$1"
  local key="$2"
  local warehouse_filter="$3"
  local expected_code="$4"
  local jq_filter="$5"
  local holder_app="tc-holder-${RUN_ID//[^a-zA-Z0-9]/}"
  local holder_sql
  local holder_ready=0
  local request_waiting=0
  local attempt
  local body_file="$TMP_DIR/race-body.json"
  local status_file="$TMP_DIR/race-status.txt"

  reset_stock
  holder_sql="BEGIN;
SELECT i.id
FROM inventory i
JOIN warehouses w ON w.id = i.warehouse_id
JOIN products p ON p.id = i.product_id
WHERE ${warehouse_filter} AND p.sku = 'PVC-GLUE-QT'
FOR UPDATE OF i;
SELECT pg_sleep(12);
UPDATE inventory i
SET quantity = 0
FROM warehouses w, products p
WHERE i.warehouse_id = w.id AND i.product_id = p.id
  AND ${warehouse_filter} AND p.sku = 'PVC-GLUE-QT';
COMMIT;"

  PGAPPNAME="$holder_app" psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "$holder_sql" >"$TMP_DIR/race-holder.log" 2>&1 &
  RACE_HOLDER_PID=$!

  for ((attempt = 0; attempt < 100; attempt++)); do
    if [[ "$(db_scalar "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$holder_app' AND wait_event_type = 'Timeout';")" -gt 0 ]]; then
      holder_ready=1
      break
    fi
    sleep 0.1
  done

  if [[ "$holder_ready" -ne 1 ]]; then
    fail "$name: acquire inventory locks" "lock holder ready" "timeout" "$(<"$TMP_DIR/race-holder.log")"
    kill "$RACE_HOLDER_PID" 2>/dev/null || true
    wait "$RACE_HOLDER_PID" 2>/dev/null || true
    RACE_HOLDER_PID=""
    return
  fi

  request_order_to_files "$BASE_BODY" "$key" "$body_file" "$status_file" &
  local request_pid=$!

  for ((attempt = 0; attempt < 80; attempt++)); do
    if [[ "$(db_scalar "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%inventory%' AND application_name <> '$holder_app';")" -gt 0 ]]; then
      request_waiting=1
      break
    fi
    sleep 0.1
  done

  if [[ "$request_waiting" -ne 1 ]]; then
    fail "$name: request reaches reservation lock" "waiting inventory update" "timeout" "race was not synchronized"
    kill "$RACE_HOLDER_PID" 2>/dev/null || true
    wait "$RACE_HOLDER_PID" 2>/dev/null || true
    RACE_HOLDER_PID=""
    wait "$request_pid" 2>/dev/null || true
    return
  fi

  if ! wait "$RACE_HOLDER_PID"; then
    RACE_HOLDER_PID=""
    wait "$request_pid" 2>/dev/null || true
    fail "$name: drain candidate stock" "SQL commit" "failed" "$(<"$TMP_DIR/race-holder.log")"
    return
  fi
  RACE_HOLDER_PID=""
  wait "$request_pid"
  HTTP_CODE="$(<"$status_file")"
  HTTP_BODY="$(<"$body_file")"
  check_response "$name" "$expected_code" "$jq_filter"
}

ids="$(psql "$DATABASE_URL" -XAt -F '|' -v ON_ERROR_STOP=1 -c "
  SELECT
    (SELECT id FROM products WHERE sku = 'PVC-GLUE-QT'),
    (SELECT id FROM products WHERE sku = 'PVC-90-150'),
    (SELECT id FROM products WHERE sku = 'PVC-LB-075'),
    (SELECT id FROM products WHERE sku = 'RMC-075'),
    (SELECT id FROM products WHERE sku = 'BREAKER-2P-40A');
")"
IFS='|' read -r GLUE_ID PVC90_ID NO_STOCK_ID RMC_ID INACTIVE_ID <<<"$ids"

for id in "$GLUE_ID" "$PVC90_ID" "$NO_STOCK_ID" "$RMC_ID" "$INACTIVE_ID"; do
  [[ "$id" =~ ^[0-9]+$ ]] || {
    printf 'Fixture products are missing. Load the SQL test data first.\n' >&2
    exit 2
  }
done

fixture_counts="$(psql "$DATABASE_URL" -XAt -F '|' -v ON_ERROR_STOP=1 -c "
  SELECT
    (SELECT count(*) FROM customers WHERE email = 'taylor@example.com'),
    (SELECT count(*) FROM addresses WHERE fingerprint = '[\"101 nw 1st ave\",\"\",\"miami\",\"fl\",\"33130\",\"us\"]'),
    (SELECT count(*) FROM warehouses WHERE name IN ('Miami Closest','Miami Backup','Orlando Stock','Austin Stock','Los Angeles Empty'));
")"
[[ "$fixture_counts" == '1|1|5' ]] || {
  printf 'Fixture customer/address/warehouses are missing or duplicated (got %s). Load the SQL test data first.\n' "$fixture_counts" >&2
  exit 2
}

# Start each run from the documented stock matrix rather than relying on the
# smaller quantities from the SQL fixture insert.
reset_stock

BASE_BODY="$(jq -nc --argjson glue "$GLUE_ID" '{
  customer: {name:"Taylor",email:"taylor@example.com",phone:"+1 305 555 0201"},
  address: {line1:"101 NW 1st Ave",line2:null,city:"Miami",region:"FL",postalCode:"33130",country:"US"},
  items: [{productId:$glue,quantity:1}],
  creditCardNumber:"4242424242424242"
}')"
LONG_LINE="$(printf '%201s' '' | tr ' ' x)"

request_get /health
check_response 'Health endpoint' 200 '.status == "ok"'

# Invalid input cases
body="$(jq -c '.customer.name = ""' <<<"$BASE_BODY")"
check_order 'Blank customer name' 400 '.statusCode == 400 and .message == "Validation failed" and any(.errors[]?; .path == "customer.name")' "$body"
body="$(jq -c '.customer.name = "Taylor Lee"' <<<"$BASE_BODY")"
check_order 'Non-letter customer name' 400 '.statusCode == 400 and any(.errors[]?; .path == "customer.name")' "$body"
long_name="$(printf 'A%.0s' {1..101})"
body="$(jq -c --arg n "$long_name" '.customer.name = $n' <<<"$BASE_BODY")"
check_order 'Overlong customer name' 400 '.statusCode == 400 and any(.errors[]?; .path == "customer.name")' "$body"

body="$(jq -c '.customer.email = "not-an-email"' <<<"$BASE_BODY")"
check_order 'Malformed customer email' 400 '.statusCode == 400 and any(.errors[]?; .path == "customer.email")' "$body"
body="$(jq -c '.customer.phone = 123' <<<"$BASE_BODY")"
check_order 'Non-string customer phone' 400 '.statusCode == 400 and any(.errors[]?; .path == "customer.phone")' "$body"

body="$(jq -c '.address |= del(.city)' <<<"$BASE_BODY")"
check_order 'Missing required address city' 400 '.statusCode == 400 and any(.errors[]?; .path == "address.city")' "$body"
body="$(jq -c '.address.line1 = "" | .address.city = "" | .address.postalCode = ""' <<<"$BASE_BODY")"
check_order 'Blank required address fields' 400 '.statusCode == 400 and any(.errors[]?; .path == "address.line1") and any(.errors[]?; .path == "address.city") and any(.errors[]?; .path == "address.postalCode")' "$body"
body="$(jq -c --arg line2 "$LONG_LINE" '.address.line2 = $line2' <<<"$BASE_BODY")"
check_order 'Overlong optional address line 2' 400 '.statusCode == 400 and any(.errors[]?; .path == "address.line2")' "$body"
body="$(jq -c '.address.region = "F" | .address.country = "USA"' <<<"$BASE_BODY")"
check_order 'Invalid region and country code lengths' 400 '.statusCode == 400 and any(.errors[]?; .path == "address.region") and any(.errors[]?; .path == "address.country")' "$body"

body="$(jq -c '.items = []' <<<"$BASE_BODY")"
check_order 'Empty item list' 400 '.statusCode == 400 and any(.errors[]?; .path == "items")' "$body"
body="$(jq -c '.items = [range(0;101) | {productId:(10000 + .),quantity:1}]' <<<"$BASE_BODY")"
check_order 'Oversized item list' 400 '.statusCode == 400 and any(.errors[]?; .path == "items")' "$body"
body="$(jq -c '.items = [{productId:0,quantity:1.5}]' <<<"$BASE_BODY")"
check_order 'Non-positive ID and non-integer quantity' 400 '.statusCode == 400 and any(.errors[]?; .path == "items.0.productId") and any(.errors[]?; .path == "items.0.quantity")' "$body"
body="$(jq -c '.items[0].quantity = 1000001' <<<"$BASE_BODY")"
check_order 'Quantity above supported maximum' 400 '.statusCode == 400 and any(.errors[]?; .path == "items.0.quantity")' "$body"
body="$(jq -c '.creditCardNumber = "123456789012"' <<<"$BASE_BODY")"
check_order 'Invalid card number length' 400 '.statusCode == 400 and any(.errors[]?; .path == "creditCardNumber")' "$body"

# Customer and address cases
new_email="new${RUN_ID}@example.com"
new_line="700 Test ${RUN_ID} Ave"
body="$(jq -c --arg email "$new_email" --arg line1 "$new_line" '.customer = {name:"Avery",email:$email,phone:"+1 305 555 0299"} | .address.line1 = $line1' <<<"$BASE_BODY")"
check_order 'Create a new customer and address' 201 ".state == \"active\" and .customer.email == \"$new_email\" and .shippingAddress.line1 == \"$new_line\"" "$body" "${RUN_ID}-new-customer"
check_db_value 'New customer persisted' 1 "$(db_scalar "SELECT count(*) FROM customers WHERE email = '$new_email';")"
check_db_value 'New address persisted' 1 "$(db_scalar "SELECT count(*) FROM addresses WHERE line1 = '$new_line';")"

check_order 'Existing customer with matching details' 201 '.state == "active" and .customer.email == "taylor@example.com"' "$BASE_BODY" "${RUN_ID}-existing-customer"
body="$(jq -c '.customer.email = "TAYLOR@EXAMPLE.COM"' <<<"$BASE_BODY")"
check_order 'Case-insensitive customer email match' 201 '.state == "active" and .customer.email == "taylor@example.com"' "$body" "${RUN_ID}-email-case"
body="$(jq -c '.customer.name = "Jordan"' <<<"$BASE_BODY")"
check_order 'Reject mismatched existing customer name' 409 '.statusCode == 409 and .message == "Name does not match the existing customer for email taylor@example.com"' "$body"
body="$(jq -c '.customer.phone = "+1 305 555 9999"' <<<"$BASE_BODY")"
check_order 'Reject mismatched existing customer phone' 409 '.statusCode == 409 and .message == "Phone does not match the existing customer for email taylor@example.com"' "$body"

normalized_fingerprint='["101 nw 1st ave","","miami","fl","33130","us"]'
before="$(db_scalar "SELECT count(*) FROM addresses WHERE fingerprint = '$normalized_fingerprint';")"
body="$(jq -c '.address.line1 = " 101 nw 1st ave " | .address.city = " MIAMI " | .address.region = "fl" | .address.country = "us"' <<<"$BASE_BODY")"
check_order 'Reuse normalized existing address' 201 '.state == "active" and .shippingAddress.line1 == "101 nw 1st ave"' "$body" "${RUN_ID}-normalized-address"
after="$(db_scalar "SELECT count(*) FROM addresses WHERE fingerprint = '$normalized_fingerprint';")"
check_db_value 'Normalized address remains deduplicated' "$before" "$after"

different_line="102 NW ${RUN_ID} Ave"
body="$(jq -c --arg line1 "$different_line" '.address.line1 = $line1' <<<"$BASE_BODY")"
check_order 'Create a distinct normalized address' 201 ".state == \"active\" and .shippingAddress.line1 == \"$different_line\"" "$body" "${RUN_ID}-different-address"
check_db_value 'Distinct address persisted' 1 "$(db_scalar "SELECT count(*) FROM addresses WHERE line1 = '$different_line';")"

body="$(jq -c '.customer = {name:"Jordan",email:"jordan@example.com",phone:"+1 305 555 0202"}' <<<"$BASE_BODY")"
check_order 'Reuse address across customers' 201 '.state == "active" and .customer.email == "jordan@example.com" and .shippingAddress.line1 == "101 NW 1st Ave"' "$body" "${RUN_ID}-shared-address"
check_db_value 'Shared address remains one row' 1 "$(db_scalar "SELECT count(*) FROM addresses WHERE fingerprint = '$normalized_fingerprint';")"

body="$(jq -c '.address.country = "ZZ"' <<<"$BASE_BODY")"
check_order 'Reject unknown country' 400 '.statusCode == 400 and .message == "Unknown country ZZ"' "$body"
body="$(jq -c '.address.region = "ZZ"' <<<"$BASE_BODY")"
check_order 'Reject unknown region' 400 '.statusCode == 400 and .message == "Unknown region ZZ"' "$body"

no_stock_email="nostock${RUN_ID}@example.com"
no_stock_line="800 No Stock ${RUN_ID} Ave"
body="$(jq -c --arg email "$no_stock_email" --arg line1 "$no_stock_line" --argjson noStock "$NO_STOCK_ID" --argjson glue "$GLUE_ID" \
  '.customer = {name:"Avery",email:$email,phone:"+1 305 555 0299"} | .address.line1 = $line1 | .items = [{productId:$glue,quantity:1},{productId:$noStock,quantity:1}]' <<<"$BASE_BODY")"
check_order 'No candidate does not persist new customer or address' 422 '.statusCode == 422 and .message == "No single warehouse can fulfil the entire order"' "$body" "${RUN_ID}-no-warehouse"
check_db_value 'No-warehouse customer was not persisted' 0 "$(db_scalar "SELECT count(*) FROM customers WHERE email = '$no_stock_email';")"
check_db_value 'No-warehouse address was not persisted' 0 "$(db_scalar "SELECT count(*) FROM addresses WHERE line1 = '$no_stock_line';")"

# Stock selection cases share the initialized baseline. PVC 90 is untouched
# until the exact-stock case; that case consumes its Miami Closest inventory.
body="$(jq -c --argjson pvc90 "$PVC90_ID" '.items = [{productId:$pvc90,quantity:100}]' <<<"$BASE_BODY")"
check_order 'Reserve exactly available stock' 201 '.state == "active" and .warehouse.name == "Miami Closest" and .items[0].quantity == 100 and .totalAmount == "120000"' "$body" "${RUN_ID}-exact-stock"
check_db_value 'Exact-stock inventory depleted' 0 "$(db_scalar "SELECT i.quantity FROM inventory i JOIN warehouses w ON w.id=i.warehouse_id JOIN products p ON p.id=i.product_id WHERE w.name='Miami Closest' AND p.sku='PVC-90-150';")"

body="$(jq -c '.items[0].quantity = 501' <<<"$BASE_BODY")"
check_order 'Reject quantity above all warehouse stock' 422 '.statusCode == 422 and .message == "No single warehouse can fulfil the entire order"' "$body"
body="$(jq -c --argjson noStock "$NO_STOCK_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$noStock,quantity:1}]' <<<"$BASE_BODY")"
check_order 'Reject basket containing active product with no stock' 422 '.statusCode == 422 and .message == "No single warehouse can fulfil the entire order"' "$body"
body="$(jq -c --argjson pvc90 "$PVC90_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$pvc90,quantity:1}]' <<<"$BASE_BODY")"
check_order 'Fulfill multi-product order at one warehouse' 201 '.state == "active" and .warehouse.name == "Miami Backup" and (.items | length) == 2 and .totalAmount == "2050"' "$body" "${RUN_ID}-multi-product"
body="$(jq -c --argjson pvc90 "$PVC90_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:250},{productId:$pvc90,quantity:250}]' <<<"$BASE_BODY")"
check_order 'Reject products stocked only at separate warehouses' 422 '.statusCode == 422 and .message == "No single warehouse can fulfil the entire order"' "$body"
check_order 'Choose nearest fulfilling warehouse' 201 '.state == "active" and .warehouse.name == "Miami Closest"' "$BASE_BODY" "${RUN_ID}-nearest"

# The controlled race cases intentionally restore stock before each setup.
run_controlled_race \
  'Fallback to farther warehouse after nearest stock race' \
  "${RUN_ID}-fallback" \
  "w.name = 'Miami Closest'" \
  201 \
  '.state == "active" and .warehouse.name == "Miami Backup"'

run_controlled_race \
  'Record loss after every selected candidate is drained' \
  "${RUN_ID}-all-candidates-race" \
  "w.name IN ('Miami Closest', 'Miami Backup', 'Orlando Stock')" \
  409 \
  '.statusCode == 409 and (.message | contains("state '\''created'\''")) and (.message | contains("no stock was reserved"))'

# Race orchestration drains stock deliberately. Reinitialize once before the
# remaining product, payment, and idempotency cases.
reset_stock

body="$(jq -c --argjson inactive "$INACTIVE_ID" '.items = [{productId:$inactive,quantity:1}]' <<<"$BASE_BODY")"
check_order 'Reject inactive product' 400 ".statusCode == 400 and .message == \"Product $INACTIVE_ID is not available\"" "$body"
body="$(jq -c '.items[0].productId = 999999999' <<<"$BASE_BODY")"
check_order 'Reject unknown product ID' 404 '.statusCode == 404 and .message == "Product 999999999 not found"' "$body"
body="$(jq -c --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$glue,quantity:2}]' <<<"$BASE_BODY")"
check_order 'Reject duplicate product IDs' 400 '.statusCode == 400 and any(.errors[]?; .path == "items")' "$body"
body="$(jq -c --argjson rmc "$RMC_ID" --argjson glue "$GLUE_ID" '.items = [{productId:$glue,quantity:1},{productId:$rmc,quantity:1}]' <<<"$BASE_BODY")"
check_order 'Reject mixed currencies' 400 '.statusCode == 400 and .message == "All products in an order must share the same currency"' "$body"

body="$(jq -c --argjson pvc90 "$PVC90_ID" '.items = [{productId:$pvc90,quantity:1}]' <<<"$BASE_BODY")"
check_order 'Successful payment activates order and reserves stock' 201 '.state == "active" and .currency == "USD" and .items[0].sku == "PVC-90-150"' "$body" "${RUN_ID}-paid"
check_db_value 'Successful payment decremented PVC 90 stock' 99 "$(db_scalar "SELECT i.quantity FROM inventory i JOIN warehouses w ON w.id=i.warehouse_id JOIN products p ON p.id=i.product_id WHERE w.name='Miami Closest' AND p.sku='PVC-90-150';")"

body="$(jq -c '.creditCardNumber = "4242424242420000"' <<<"$BASE_BODY")"
check_order 'Declined payment returns 402 and restores stock' 402 '.statusCode == 402 and .message == "Payment was declined"' "$body" "${RUN_ID}-decline"
check_db_value 'Declined payment restored glue stock' 100 "$(db_scalar "SELECT i.quantity FROM inventory i JOIN warehouses w ON w.id=i.warehouse_id JOIN products p ON p.id=i.product_id WHERE w.name='Miami Closest' AND p.sku='PVC-GLUE-QT';")"

key="${RUN_ID}-replay"
request_order "$BASE_BODY" "$key"
first_id="$(jq -r '.id // empty' <<<"$HTTP_BODY")"
check_response 'Initial idempotent order' 201 '.state == "active"'
request_order "$BASE_BODY" "$key"
check_response 'Matching idempotency replay' 200 ".id == $first_id and .state == \"active\""

key="${RUN_ID}-changed-payload"
request_order "$BASE_BODY" "$key"
check_response 'Initial order for changed-payload conflict' 201 '.state == "active"'
body="$(jq -c '.items[0].quantity = 2' <<<"$BASE_BODY")"
check_order 'Reject changed payload for existing key' 409 ".statusCode == 409 and (.message | contains(\"$key\")) and (.message | contains(\"different payload\"))" "$body" "$key"

key="${RUN_ID}-concurrent-key"
request_order_to_files "$BASE_BODY" "$key" "$TMP_DIR/concurrent-a.json" "$TMP_DIR/concurrent-a.status" &
request_a=$!
request_order_to_files "$BASE_BODY" "$key" "$TMP_DIR/concurrent-b.json" "$TMP_DIR/concurrent-b.status" &
request_b=$!
wait "$request_a"
wait "$request_b"
status_a="$(<"$TMP_DIR/concurrent-a.status")"
status_b="$(<"$TMP_DIR/concurrent-b.status")"
id_a="$(jq -r '.id // empty' "$TMP_DIR/concurrent-a.json")"
id_b="$(jq -r '.id // empty' "$TMP_DIR/concurrent-b.json")"
if { [[ "$status_a" == 201 && "$status_b" == 200 ]] || [[ "$status_a" == 200 && "$status_b" == 201 ]]; } && [[ -n "$id_a" && "$id_a" == "$id_b" ]]; then
  pass 'Concurrent requests with the same idempotency key' '201/200'
else
  fail 'Concurrent requests with the same idempotency key' 'one 201, one 200, same order ID' "$status_a/$status_b" "$(<"$TMP_DIR/concurrent-a.json") $(<"$TMP_DIR/concurrent-b.json")"
fi

request_order "$BASE_BODY"
no_key_id_a="$(jq -r '.id // empty' <<<"$HTTP_BODY")"
check_response 'First identical request without idempotency key' 201 '.state == "active"'
request_order "$BASE_BODY"
no_key_id_b="$(jq -r '.id // empty' <<<"$HTTP_BODY")"
if [[ "$HTTP_CODE" == 201 && -n "$no_key_id_a" && -n "$no_key_id_b" && "$no_key_id_a" != "$no_key_id_b" ]]; then
  pass 'Second identical request without idempotency key creates a distinct order' "$HTTP_CODE"
else
  fail 'Second identical request without idempotency key creates a distinct order' '201 and a different order ID' "$HTTP_CODE" "$HTTP_BODY"
fi

declined_body="$(jq -c '.creditCardNumber = "4242424242420000"' <<<"$BASE_BODY")"
key="${RUN_ID}-declined-replay"
check_order 'First declined request is recorded' 402 '.statusCode == 402 and .message == "Payment was declined"' "$declined_body" "$key"
check_order 'Recorded declined request replays its outcome' 402 '.statusCode == 402 and (.message | contains("recorded as '\''cancelled'\''")) and (.message | contains("stock was returned"))' "$declined_body" "$key"

key="${RUN_ID}-retrieve"
request_order "$BASE_BODY" "$key"
retrieved_id="$(jq -r '.id // empty' <<<"$HTTP_BODY")"
check_response 'Create order for retrieval case' 201 '.state == "active"'
if [[ -n "$retrieved_id" ]]; then
  request_get "/orders/$retrieved_id"
  check_response 'Retrieve order with customer, warehouse, and items' 200 ".id == $retrieved_id and .customer.email == \"taylor@example.com\" and .warehouse.name != null and (.items | length) == 1"
else
  fail 'Retrieve order with customer, warehouse, and items' 'order ID in POST response' 'missing' "$HTTP_BODY"
fi

request_get /orders/999999999999
check_response 'GET an unknown order ID' 404 '.statusCode == 404 and .message == "Order 999999999999 not found"'

printf '\nTest suite finished: %d passed, %d failed.\n' "$PASSED" "$FAILED"
if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
