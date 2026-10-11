# AGENTS.md

## Database migrations

Every migration MUST have a descriptive name. Never run `drizzle-kit generate`
without `--name`; the default random slug (e.g. `0009_hot_wendell_rand`) is not
allowed.

```bash
npm run db:generate -- --name <descriptive_name>
```

Name the migration after the change it makes (e.g. `add_inventory`,
`drop_order_status`). Migrations are ordered by the index in
`drizzle/meta/_journal.json`; snapshots are index-named, and the journal `tag`
must match the `.sql` filename.
