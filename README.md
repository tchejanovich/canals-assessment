## Project setup

### Prerequisites

- **Node.js 24** and npm. The Docker image uses Node.js 24.
- **PostgreSQL** with the **PostGIS** extension available. The migrations create
  the extension and require a database user allowed to do so. PostgreSQL 16 with
  PostGIS 3 is a suitable local setup; the project does not pin a server version.

### Installing PostGIS
- macOS: Run brew install postgis with Homebrew; it installs PostGIS and its PostgreSQL dependencies.
- Windows: Install PostgreSQL using the EDB installer, then use Stack Builder to add PostGIS.
- Linux (Ubuntu/Debian): Run sudo apt install postgresql postgis; use your PostgreSQL version’s PostGIS package if needed.
  

### Configure and run

1. Create an empty PostgreSQL database, for example `canals`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your local connection
   string. Set `PORT` if you don't want to use the default `3000`.
3. Install the locked dependencies and start the development server:

   ```bash
   npm ci
   npm run start:dev
   ```

   On startup, the application applies pending migrations and seeds the sample
   customer, products, warehouses, and inventory.

4. Check that the server is responding:

   ```bash
   curl http://localhost:3000/health
   ```

   The response should be `{"status":"ok"}`.

## Tech stack

- **Node.js and TypeScript:** Chosen to match Canals' technology stack.
- **NestJS:** Makes it straightforward to structure the service with different
  architectural patterns, and it's the Node.js/TypeScript framework I'm most
  familiar with.
- **Drizzle ORM:** A popular, lightweight ORM that's easy to use while keeping
  database queries flexible and close to SQL.
- **PostgreSQL:** Chosen to match Canals' database stack.
- **AWS:** Chosen to match Canals' infrastructure and because it's the platform
  I know best. The deployment uses RDS for PostgreSQL, ECR for container images,
  ECS for the service, and an EC2 Application Load Balancer. The application is
  available to test at
  [tchejanovich-canals-assessment.com](https://tchejanovich-canals-assessment.com/health).

## API Docs

### `GET /health`

Checks that the application is responding.

- `200 OK` — the service is healthy.

### `POST /orders`

Creates an order from customer details, a shipping address, product items, and a
credit card number. The `Idempotency-Key` header is optional but recommended.
Returns the order, including its customer, selected warehouse, and line items.

```json
{
  "customer": {
    "name": "Taylor",
    "email": "taylor@example.com",
    "phone": "+1 305 555 0201"
  },
  "address": {
    "line1": "123 Main St",
    "line2": null,
    "city": "Miami",
    "region": "FL",
    "postalCode": "33130",
    "country": "US"
  },
  "items": [{ "productId": 1, "quantity": 2 }],
  "creditCardNumber": "4242424242424242"
}
```
**Available products ID on https://tchejanovich-canals-assessment.com: 1,2,3,4,5,13, 14,15,16 and 17.**
- `201 Created` — a new order was placed, stock reserved, and payment approved.
- `200 OK` — a matching idempotency-key replay; returns the existing order.
- `400 Bad Request` — invalid input or a business-rule violation, such as an
  unknown country/region, inactive product, or mixed-currency items.
- `402 Payment Required` — payment was declined or capture failed; the order is
  cancelled and reserved stock is restored.
- `404 Not Found` — a referenced product does not exist.
- `409 Conflict` — the customer details do not match an existing customer, the
  idempotency key was reused with a different payload, or all warehouse
  candidates lost the stock-reservation race.
- `422 Unprocessable Entity` — no single warehouse currently has all requested
  items in the requested quantities.
- `500 Internal Server Error` — an unexpected server error occurred.

### `GET /orders/:id`

Returns an order by its positive integer ID, including its customer, warehouse,
and line items. This endpoint was not required for the assessment; it was added
to make debugging easier and facilitate the reviewer's work.

- `200 OK` — the order was found.
- `400 Bad Request` — the ID is not a positive integer.
- `404 Not Found` — no order exists with that ID.
- `500 Internal Server Error` — an unexpected server error occurred.

## Testing the application.

The application is available for testing on **[https://tchejanovich-canals-assessment.com](https://tchejanovich-canals-assessment.com/health)**.

Test scenarios, curl examples, and expected responses are in [testing/test-cases.md](testing/test-cases.md).

## Technical decisions explained

### Warehouses don't use the `addresses` table

The `addresses` table is designed for customers only. Warehouses have their address embedded in the row. The fields are mostly the same, but I thought it made sense to keep them separate because they serve different entities. Eventually, they could differ in multiple ways, like the warehouse address having warehouse-specific data, or the customer address syncing with an external shipping platform (and therefore having an external_id).

### Nearest-warehouse selection is done in the database

Deciding how and where to calculate the distance from the customer address to the warehouse was probably the toughest decision of the assessment. There were two main options:

- Getting all the warehouses with enough stock from the DB and then calculating and sorting by distance in memory.
- Doing the stock check, the distance calculation, and sorting in the DB.

The first approach can be faster and causes less trouble for the DB, but it fails at scale: what if we have thousands or millions of warehouses that can fulfill the order?

In that scenario, checking the DB makes more sense than reading and filtering a bunch of rows in memory.

If we know we're gonna deal with a low amount of warehouse candidates, the first option is better.

In this case, I chose the second one since it scales better, and the PostGIS index can make the distance ranking more performant. Indices are expensive in storage, but this distance calculation is core to the solution, so the cost seems fair.

That said, I don't think there is a silver bullet here, and the best answer can only be determined by testing against the actual data.

### Order states

The orders have 4 possible states: `created → reserved → active`, with `failed` as the terminal state for a declined card or stock issue. I'll explain them from the most obvious to the least obvious.

- `active`: The happy path. The order is created successfully, and the payment is captured.
- `failed`: This is the final order state when either the payment is declined, or the order was created, but then the necessary stock was reserved by another order. The failure reason will explain which one was.
- `created`: This is the initial order state. It's only a transient state, no order will have `created` as its final state.
- `reserved`: The order transitions to this state when it was created and the stock was reserved, but the payment hasn't gone through yet. It's only a final state when the server crashes before the payment can be captured. In a real system, there should be a periodic cron job that releases the stock reserved by these orders.

### Idempotency

This point made the code more complex in many ways, but I think it's necessary for a high-traffic, concurrency-safe, error-safe API.

The POST endpoint can receive an optional (but recommended) idempotency key. If the server receives two requests with the same key, only one should proceed to payment capture, but both should be handled and return the correct states (e.g., the first returns a 201 and the second a 200). The system also supports retrying a reserved order after a system failure.

### Payments API mocks

The Payments API was mocked, but I decided to keep it real by sticking to a realistic payments interface with 3 methods: authorize, capture, and void.

The system counts with the Payments API using an idempotency key (like Stripe), which ensures no order gets charged twice. I implemented some small storage mechanism in the mock to do this.

### The Address is snapshoted in the order

The `order` is associated with the `address`, but the order also snapshots the address info. Per the current system status, this is redundant since no event can modify the address row, but in a more realistic system, one might. It's also common practice to snapshot these kinds of fields in the order table.
