# Persistence boundary

`createDatabase` creates a PostgreSQL/Drizzle client; it does not migrate or seed data. The scaffold does not call it. Add reviewed schemas/migrations in this package as part of the persistence workstream, including task membership, sessions, ordered events and leased jobs. API handlers and workers must share durable state rather than independent in-memory stores. Validate recovery and duplicate delivery before claiming restart safety.
