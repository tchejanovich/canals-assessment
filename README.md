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
