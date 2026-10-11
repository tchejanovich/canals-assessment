<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Technical decisions

### Language and framework

**TypeScript on NestJS, to match the company's stack**

The service is written in TypeScript on NestJS, and the deciding factor is that
Canals already builds on this stack. Writing the assessment in the language and
framework the company actually runs means the code, conventions and design
decisions here transfer directly to production work rather than living as a
throwaway prototype, and it is what the team reviewing it can read, extend and
deploy without a translation layer.

Independent of that, NestJS fits this service well: its dependency-injection and
module system made the external integrations (geocoding, payments) swappable
mocks behind typed interfaces with no change to callers, and the framework's
opinionated structure keeps the HTTP, service and persistence layers clearly
separated.

**Drizzle ORM over a heavier ORM**

Drizzle was chosen over a heavier, more abstract ORM (or a plain query builder)
because this service leans on PostgreSQL-specific features that an abstraction
would fight rather than help with:

- The schema is defined once in TypeScript and is the single source of truth for
  both the types and the generated migrations, so schema drift and hand-written
  DDL are avoided.
- The queries are intentionally close to SQL — `VALUES` joins, the atomic
  conditional `UPDATE ... WHERE quantity >= ?` that prevents overselling, and the
  PostGIS nearest-neighbour operators. Drizzle composes raw SQL with typed
  columns instead of hiding those capabilities, so the concurrency and
  distance-ranking logic is expressed directly and can be reviewed as SQL.
- It adds no runtime metadata/reflection layer, keeping the persistence boundary
  thin and predictable.

### Database

**Countries and regions live in their own tables**

Countries and regions are reference (lookup) data referenced by both `addresses`
and `warehouses`. Modeling them as tables rather than free-text columns:

- Removes duplication and keeps a single spelling/source of truth for every
  country and first-level region, instead of repeating (and mistyping) strings
  across rows.
- Enforces integrity at the database level: `addresses` and `warehouses` hold
  `country_id` / `region_id` foreign keys, and a region's code is unique within
  its country, so an invalid or inconsistent state can't be stored.
- Gives stable ids and codes (ISO-3166 country codes, state codes) to join and
  aggregate on, and lets new countries/regions be added as data rather than a
  schema change.

**Warehouses embed their address, customers use the `addresses` table**

A warehouse's address is an intrinsic, single (1:1) attribute of the facility:
each warehouse has exactly one, it never pluralizes, and it changes rarely. It is
therefore stored inline on the `warehouses` row rather than in `addresses`. This
avoids a join and a foreign key that could only ever point to one row, and keeps
the warehouse self-contained.

Customer addresses are different in nature, which is why they get their own
table:

- A customer can have many addresses (1:N).
- Addresses are shared, deduplicated data: a normalised `fingerprint` with a
  unique index means the same physical address (and its geocoded coordinates)
  is only stored/geocoded once, even across customers.
- They are mutable — a customer can edit them — so they're kept as independent
  records rather than copied inline.

Because orders snapshot the chosen shipping address at purchase time, later edits
to a customer's `addresses` row (or an update to a warehouse's inline address) do
not rewrite historical order data.

**Nearest-warehouse selection uses PostGIS**

An order must be fulfilled from a single warehouse, so the service ranks the
warehouses that stock *every* requested product by distance to the shipping
address. That ranking is done in the database with PostGIS rather than by
fetching candidates and computing distances in application code:

- Warehouse coordinates are mirrored into a `geography(Point, 4326)` column
  (`warehouses.location`) backed by a GiST index. `latitude`/`longitude` stay the
  writable source of truth; `location` is a generated, read-only shadow that
  Postgres rebuilds automatically whenever either coordinate changes, so the two
  can never drift and the spatial type never leaks into the application layer.
- `geography` (rather than `geometry`) computes distances on the WGS84 spheroid
  in metres, and the GiST index supports the `<->` nearest-neighbour operator, so
  `ORDER BY location <-> :origin` walks the index nearest-first instead of
  measuring every warehouse.
- Ranking is split into two queries — first the stock filter
  (`GROUP BY ... HAVING COUNT(*) = n`), then distance ordering over the survivors.
  The reason is non-obvious and planner-specific, so it is explained in full
  below.
- The result is a nearest-first *list*, not a single pick. Stock is re-checked
  under a row lock at reservation time, so when two orders race for the same
  warehouse the loser falls back to the next-nearest candidate that can still
  fulfil the order rather than failing outright.
- The migration that adds the column also runs `CREATE EXTENSION postgis`, so a
  fresh database provisions the extension automatically.

**Why the candidate ranking is two queries, not one**

The obvious way to write the ranking is a single query that filters on stock and
orders by distance at once:

```sql
SELECT w.id
FROM warehouses w
JOIN inventory i ON i.warehouse_id = w.id
JOIN (VALUES ...) AS req(product_id, quantity) ON req.product_id = i.product_id
WHERE w.active AND i.quantity >= req.quantity
GROUP BY w.id, w.location
HAVING COUNT(*) = :n
ORDER BY w.location <-> :origin
LIMIT :k;
```

This silently loses the index. The `<->` nearest-neighbour optimisation only
applies when `ORDER BY <->` is the top-level ordering of a *scan*; a `GROUP BY`
forces the rows to be aggregated first, so the ordering becomes a sort over the
aggregated result and the GiST index is bypassed. `EXPLAIN` on a 5,000-row table
confirms it — the plan is `Limit -> Sort -> HashAggregate -> Hash Join ->
Seq Scan`, with no `Index Scan using ..._gist`, i.e. every fulfilling warehouse
is measured and sorted.

Splitting keeps the ranking step a plain scan
(`WHERE id = ANY(:ids) ORDER BY location <-> :origin LIMIT :k`), which the planner
serves with the GiST index:

```text
Limit
  -> Index Scan using warehouses_location_gist_idx on warehouses
       Order By: (location <-> :origin)
```

so `LIMIT` stops after visiting the nearest candidates instead of measuring and
sorting every fulfilling warehouse. The trade-off is a second round trip, and at
a handful of warehouses the planner may just sort anyway — the split is a
scalability hedge rather than a change you can feel at this size.

The one-query form *can* keep the index if the stock test is written as a per-row
predicate (no aggregation) instead of a `GROUP BY`:

```sql
SELECT w.id
FROM warehouses w
WHERE w.active AND NOT EXISTS (
  SELECT 1 FROM (VALUES ...) AS req(product_id, quantity)
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory i
    WHERE i.warehouse_id = w.id AND i.product_id = req.product_id
      AND i.quantity >= req.quantity
  )
)
ORDER BY w.location <-> :origin
LIMIT :k;
```

which plans as `Limit -> Nested Loop Anti Join -> Index Scan using ..._gist
... Order By`. So the split is not strictly required; it is simply the clearer of
the two index-preserving shapes.

**Concurrent stock reservation is optimistic, with nearest-first fallback**

Stock availability is checked twice, at different strengths, and the difference
is what makes the system safe under concurrency:

- **Candidate selection is an unlocked read.** `findFulfillingWarehouses` returns
  the warehouses that *currently* stock every requested item, with no locks held.
  Ranking, geocoding and pricing all happen while nothing is locked.
- **Reservation is the source of truth.** Decrementing stock is a single atomic
  `UPDATE inventory SET quantity = quantity - :q WHERE warehouse_id = :w AND
  product_id = :p AND quantity >= :q`. Under contention the second writer blocks
  on the row lock, then re-evaluates the predicate against the committed value; if
  stock is now short it updates zero rows, which `InventoryService.reserve` turns
  into a `ConflictException`. This is what makes overselling impossible — a
  `quantity >= 0` check constraint is the last-resort backstop.

This is optimistic concurrency: because the read is unlocked, a concurrent order
can drain a warehouse in the gap between candidate selection and reservation. The
reservation re-check catches that case (zero rows updated). Rather than failing
the customer, `OrdersService` walks the nearest-first candidate list and retries
the reservation on the next-nearest warehouse that can still fulfil the order,
up to `WAREHOUSE_FALLBACK_ATTEMPTS`, only surfacing a `409` once every candidate
is exhausted.

The fallback exists **only** for that window. With no concurrent writer to the
candidate's inventory the first (nearest) candidate always succeeds, since the
read that just included it cannot have lied; candidates 2..N are reached only
under contention. The number of attempts is a cheap insurance policy against
losing a sale to a race, not a correctness requirement.

Two supporting decisions:

- **Deterministic lock ordering.** A multi-item reservation updates each product
  row in turn, so `reserve` sorts the requests by `productId` first. Without this,
  two orders listing the same products in opposite order would acquire row locks
  in opposite order and deadlock even when every individual row is
  stock-sufficient.
- **Optimistic over pessimistic.** Locking the candidate rows up front
  (`SELECT ... FOR UPDATE`) would close the gap, but it would hold row locks across
  geocoding and pricing and serialize competing orders for longer. The unlocked
  read plus an atomic re-check and fallback keeps the lock window to the single
  reserve statement.

### Transaction groups: three commits, chosen by lock scope

Creating an order persists address, order, lines, stock and payment — but they
are not one transaction. The split is decided by *where the writes sit relative
to the payment call*:

- **Tx 1 — persist + reserve (one short transaction).** The address upsert, the
  order row (state `created`), its line items and the nearest-first reservation
  all commit together. If a candidate wins, the *same* row flips to `reserved`
  and gets its `warehouse_id` atomically with the stock decrement — an observer
  can never see stock taken but no order. If every candidate loses the race,
  the order stays `created` (a recorded, harmless row) and the transaction
  commits that outcome too; nothing was reserved or charged.
- **Tx 2 — capture (outside any transaction).** The payment call can take
  seconds and is retried/idempotent on the provider side. It runs *after* the
  reservation commits, so no inventory row lock is ever held across it, and
  nothing in Tx 1 depends on the payment outcome — the durable writes are not
  hostage to a provider timeout.
- **Tx 3 — finalize (tiny, guarded).** On approval, one
  `UPDATE … WHERE state = 'reserved'` flips the order to `active`. On decline, a
  *compensation* transaction flips it to `cancelled` and returns the reserved
  stock to inventory — both in the same commit, guarded on `state = 'reserved'`
  so a retried compensation matches zero rows and restores nothing twice.

Why not reserve and charge in one transaction? Transaction length and lock
scope. Holding reserved rows for the duration of a network payment serializes
other orders against those SKUs and leaves the reservation hostage to the
provider. Splitting (reserve commits → charge → compensate) bounds the lock
window to two short statements and turns a declined card into a *reversible,
recorded* fact instead of a rollback event.

Why not split order creation from reservation? Because it never extends the
lock window — the address/order/lines are written before any reserve lock is
acquired. Two transactions instead of one would leave a crash window with stock
*decremented but no committed order row* (or an orphan `created` row), and a
replay in that window would double-decrement. Keeping persist + reserve atomic
closes that correctness gap for free.

### Order states: four states, one honest lifecycle

`created → reserved → active`, with `cancelled` as the compensated terminal
state for a declined card. Each state is a committed fact, so a row always says
exactly where the order stands:

- **`created`** — header, lines and address are durably written but no warehouse
  has won the stock race yet. This is the *recorded race loss*: a `409` caused
  purely by contention is otherwise a black box (no way to measure how often the
  nearest-first fallback actually loses a sale, nothing for support to inspect),
  so the order is committed with an id and full header/line data. Deliberately
  not shippable — no warehouse assigned, and anything that lists or fulfils
  orders must filter on `state = 'active'` (the `state` + `created_at` index
  exists for that). No order is *invented* by this: the "no candidate at all"
  case returns `422` *before* any order row exists, so `created` rows only ever
  represent genuine race losses. A `created` order also keeps its idempotency
  key occupied.
- **`reserved`** — a warehouse won: stock was atomically decremented and the
  `warehouse_id` assigned, but the payment capture has not concluded. This state
  is what makes the payment call safe to move out of the transaction — the
  expensive, reversible decision (stock) is committed while the slow,
  once-captured irreversible decision (money) is still pending. A crash or
  timeout leaves a *resume point*: replaying the key re-runs the idempotent
  capture and finalizes instead of charging twice.
- **`active`** — stock reserved *and* payment captured: the order is real and
  shippable, and the only state fulfilment systems should act on.
- **`cancelled`** — the capture was declined. The reserved stock is returned to
  inventory in the same transaction that flips the state, so a `cancelled` row
  is the recorded outcome of a declined card: the client saw a `402`, but the
  row says exactly what happened, and the restored stock is auditable. The key
  stays bound, so retrying the same key returns the recorded `402` rather than
  attempting to charge again.

### Idempotency: one key = one outcome

The `Idempotency-Key` header is currently optional on `POST /orders`, but clients
should send one. Creating an order reserves stock and charges a card, so a retry
that hit the network twice must not place two orders. A client generates a fresh
key (a UUID is fine) per real attempt and reuses it when retrying that attempt.
When provided, the endpoint debounces by key: the same request replay returns the
stored result (`200`, same order id) instead of creating a duplicate order.
Requests without the header are accepted but are not deduplicated. The common
contracts are followed:

- **Payloads are compared.** A request fingerprint is stored with the order.
  Reusing a key with a *different* payload is client misuse and returns `409`:
  a stored order that no longer matches what the client asked for is never
  silently returned.
- **Racing keys are merged.** When two requests arrive with the same new key,
  the unique index lets the loser fail and attach to the committed winner —
  running the same payload check, so a concurrent key-reuse with a different
  payload also surfaces a `409`.
- **A recorded failure owns its key.** A `created` order keeps its key, so
  retrying the same key returns the recorded `409` rather than re-attempting;
  a `cancelled` order keeps it too, so a retry returns the recorded `402` for
  the declined card instead of trying to charge again. One key, one outcome —
  to try the order again the client issues a new key. This matches the
  idempotency-key contract used by payment providers such as Stripe.
- **Reservations are resumable.** A replay whose stored order is `reserved`
  means the original request committed the stock but never finished the (slow)
  capture. The replay *resumes* it: the capture is idempotent per order, so
  re-running it is safe, and the order is finalized to `active` in the reply.

### Mocks

External integrations are mocked so the project runs without third-party
credentials or network access. Each mock keeps the same async, typed contract as
the real dependency, so it can be swapped for a real client later without
changing callers.

**Geocoding — `GeocodingService.getCoordinates`**

A real geocoder turns a postal address into latitude/longitude. The mock instead
derives them *deterministically* from the normalised address:

- the address is lower-cased, trimmed and joined into one string;
- an FNV-1a hash reduces that string to a stable 32-bit integer;
- the integer is mapped onto the standard coordinate ranges — latitude
  `(hash % 1801) / 10 - 90` → −90.0…90.0, longitude
  `(hash("<address>|lon") % 3601) / 10 - 180` → −180.0…180.0. Hashing the address
  a second time with a `|lon` suffix (domain separation) keeps latitude and
  longitude independent.

Determinism is the point: the same address must always resolve to the same
coordinates, otherwise idempotent order replays, the coordinates stored on
`addresses`, and distance-based warehouse selection would be non-reproducible and
untestable. The returned coordinates are *not* geographically accurate — the mock
mimics the interface and the determinism of a real geocoder, not its accuracy.

## API endpoints and HTTP status codes

### `POST /orders`

Creates an order. Send a JSON body with a customer, shipping address, items, and
credit card number. For example:

```json
{
  "customerId": 1,
  "address": {
    "line1": "123 Main St",
    "line2": null,
    "city": "New York",
    "region": "NY",
    "postalCode": "10001",
    "country": "US"
  },
  "items": [{ "productId": 1, "quantity": 2 }],
  "creditCardNumber": "4242424242424242"
}
```

An `Idempotency-Key` header is optional, but recommended to make retries safe.
A new successful request returns `201`; a matching replay with the same key
returns `200`. Both return the order representation, including its items and
current state.

### `GET /orders/:id`

Returns the order and its items by order ID using the same representation as
`POST /orders`. The ID must be a positive integer. This endpoint was not required
by the assessment; it was added to make it easier for the reviewer to inspect an
order after creating it.

The endpoints return these status codes. The two `4xx`s below the validation
bucket that are easy to confuse are the stock cases, so they get a callout.

| Code | When it happens | What it means | What to do |
|------|-----------------|---------------|------------|
| `400 Bad Request` | `POST /orders` body validation failed, the country/region is unknown, a product is inactive, items mix currencies, or items repeat a `productId`; or `GET /orders/:id` has an invalid ID | The request is malformed or violates a business rule the server can check without stock | Fix the request; include an `Idempotency-Key` on order creation to make retries safe |
| `402 Payment Required` | The payment provider declined the card (e.g. a number ending in `0000`) | Payment was refused. The reservation was committed first, then compensated: the order is **recorded** as `cancelled` and the reserved stock returned to inventory in the same transaction (nothing ships, nothing is double-decremented) | Retry with a **new** `Idempotency-Key` (the same key will keep returning this recorded `402`). Note: `402` was chosen as the nearest standard code to “payment needed”; it is a non-standard use of the code) |
| `404 Not Found` | On `POST /orders`, `customerId` (or a `productId` in `items`) does not exist; on `GET /orders/:id`, the order ID does not exist | The referenced entity is unknown | Use an existing customer/product/order ID |
| `422 Unprocessable Entity` | **No** single warehouse currently stocks every requested line in the requested quantity | This is a stock-availability *fact*, not a race: no candidate existed at all, so no order was recorded | Reduce quantity or choose different items; may genuinely resolve later |
| `409 Conflict` | (a) every candidate for the order lost the reservation race, or (b) an `Idempotency-Key` was reused with a different payload | (a) The race window drained every warehouse between candidate selection and reservation: the order is **recorded** with `state: 'created'`, nothing reserved/charged, and the response message carries its id. (b) The key already maps to a different request | (a) Retry with a **new** `Idempotency-Key` (the same key will keep returning this recorded outcome). (b) This is a client bug — the key must describe exactly one request |
| `200 OK` | `GET /orders/:id` found the order, or `POST /orders` received an `Idempotency-Key` replay where the key and payload match an existing order | A GET returns the stored order. A POST replay creates no new order; the body is the original order (id unchanged). A `reserved` order (crash between reservation and capture) is resumed | Nothing — treat as success |
| `201 Created` | A new order was placed successfully | Stock reserved, warehouse assigned, payment approved; the body has `state: 'active'` | Nothing |

The distinction worth keeping straight: **`422` is “there was never a
candidate”, `409` is “there was, but a concurrent order beat us to it”**. Only
the `409` records an order (as `created`), which is why its body — a message
rather than an order object — points at a recorded id you can inspect. The
`402` is the same philosophy applied to declined cards: a recorded `cancelled`
order (with stock restored) rather than a silent rollback.

Anything else (server faults, unavailable dependencies) surfaces as a `500`.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

To add it to this project:

```bash
$ npm install @nestjs/observe
```

Then follow the [setup guide](https://docs.nestjs.com/observability/overview) - it takes a single import and an app key.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
