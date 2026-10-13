## Run the automated suite

Start the API and set `DATABASE_URL` to the test database;
`BASE_URL` is optional and defaults to `http://localhost:3000`. The runner requires
`curl`, `jq`, and `psql`.

```bash
DATABASE_URL='postgres://user:password@localhost:5432/canals' \
BASE_URL='http://localhost:3000' \
./testing/run-test-cases.sh
```

The script prints a pass/fail result for each check. It exits `0` if all checks
pass, `1` if a check fails, and `2` if a prerequisite is missing. It initializes
fixture inventory and creates run-specific customers, addresses, and orders in
the test database.

## Cases and expectations

### Health check

| Case                | Expected                         |
| ------------------- | -------------------------------- |
| API health endpoint | `200 OK` with `{"status":"ok"}`. |

### Input validation

| Case                                               | Expected                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Blank, non-letter, or overlong customer name       | `400 Bad Request`; validation error path `customer.name`.                                 |
| Malformed customer email                           | `400 Bad Request`; validation error path `customer.email`.                                |
| Non-string customer phone                          | `400 Bad Request`; validation error path `customer.phone`.                                |
| Missing or blank required address fields           | `400 Bad Request`; validation errors identify the missing or blank fields.                |
| Optional address line 2 longer than 200 characters | `400 Bad Request`; validation error path `address.line2`.                                 |
| Region or country code not exactly two characters  | `400 Bad Request`; validation errors identify `address.region` and `address.country`.     |
| Empty or over-100-item order list                  | `400 Bad Request`; validation error path `items`.                                         |
| Non-positive product ID or non-integer quantity    | `400 Bad Request`; validation errors identify `items.0.productId` and `items.0.quantity`. |
| Quantity above 1,000,000                           | `400 Bad Request`; validation error path `items.0.quantity`.                              |
| Credit card number outside 13–19 digits            | `400 Bad Request`; validation error path `creditCardNumber`.                              |

Validation failures return `message: "Validation failed"` and an `errors` array
containing the field paths and messages.

### Customers and addresses

| Case                                                                     | Expected                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| New customer with a new address                                          | `201 Created`; active order returns the new customer and shipping address. The customer and address are persisted. |
| Existing customer with matching email, name, and phone                   | `201 Created`; order returns the existing Taylor customer.                                                         |
| Existing customer email with different casing                            | `201 Created`; response email is normalized to `taylor@example.com`.                                               |
| Existing email with a mismatched name                                    | `409 Conflict`; message says the name does not match the existing customer.                                        |
| Existing email with a mismatched phone                                   | `409 Conflict`; message says the phone does not match the existing customer.                                       |
| Address fields match after case and surrounding-whitespace normalization | `201 Created`; one canonical address row is reused.                                                                |
| A normalized address field differs                                       | `201 Created`; a distinct address row is stored and returned in the order.                                         |
| Existing address used by a different customer                            | `201 Created`; response contains the second customer and the shared shipping address.                              |
| Unknown country or region                                                | `400 Bad Request`; message identifies the unknown country or region code.                                          |
| New customer/address with no fulfilling warehouse                        | `422 Unprocessable Entity`; no customer or address row is created.                                                 |

### Stock and warehouse selection

| Case                                                                          | Expected                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request exactly the stock available at the nearest warehouse                  | `201 Created`; active order uses Miami Closest, reserves 100 PVC 90s, and totals `120000` minor units. That inventory row becomes zero.                      |
| Request more than any one warehouse can supply                                | `422 Unprocessable Entity`; message is `No single warehouse can fulfil the entire order`.                                                                    |
| Basket contains one stocked product and one active product with no stock      | `422 Unprocessable Entity`; no single warehouse can fulfil the basket.                                                                                       |
| Multi-product order is fully stocked at one warehouse                         | `201 Created`; active order uses Miami Backup after the exact-stock case consumes Miami Closest's PVC 90 stock.                                              |
| Products are stocked only at separate warehouses for the requested quantities | `422 Unprocessable Entity`; no single warehouse can fulfil the basket.                                                                                       |
| Multiple warehouses can fulfil an order                                       | `201 Created`; the nearest fulfilling warehouse, Miami Closest, is selected.                                                                                 |
| Nearest candidate loses stock before reservation                              | `201 Created`; reservation falls back to Miami Backup. The runner coordinates this race with database row locks.                                             |
| Every selected candidate loses stock before reservation                       | `409 Conflict`; the order is recorded as `created`, with no stock reserved and no payment charged. The runner coordinates this race with database row locks. |

The runner initializes the documented 100/200/500 inventory baseline at startup.
The exact-stock case consumes the nearest warehouse's PVC 90 stock; controlled
race cases alter inventory and the runner restores the baseline afterward.

### Products and payments

| Case                                      | Expected                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Order contains an inactive product        | `400 Bad Request`; message says the product is not available.                                                 |
| Order references a nonexistent product ID | `404 Not Found`; message identifies the missing product.                                                      |
| Duplicate product IDs in one order        | `400 Bad Request`; validation error identifies `items`.                                                       |
| Order mixes product currencies            | `400 Bad Request`; message is `All products in an order must share the same currency`.                        |
| Payment is approved                       | `201 Created`; order is `active`, and PVC 90 inventory decreases by one.                                      |
| Payment is declined                       | `402 Payment Required`; message is `Payment was declined`; order is cancelled and reserved stock is restored. |

### Idempotency and retrieval

| Case                                                    | Expected                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Replay a matching request with the same idempotency key | First response is `201 Created`; replay is `200 OK` with the same order ID and no second stock reservation.   |
| Reuse an idempotency key with a changed payload         | First response is `201 Created`; changed replay is `409 Conflict`.                                            |
| Send the same idempotency key concurrently              | One response is `201 Created`, the other `200 OK`; both return the same order ID.                             |
| Send identical requests without an idempotency key      | Both responses are `201 Created` with distinct order IDs; two orders are created and stock is deducted twice. |
| Replay an order with a recorded payment decline         | Both responses are `402 Payment Required`; the replay returns the recorded cancelled outcome.                 |
| Retrieve an order by ID                                 | `GET /orders/:id` returns `200 OK` with customer, warehouse, shipping address, and line items.                |
| Retrieve an unknown order ID                            | `404 Not Found`; message identifies the missing order ID.                                                     |
