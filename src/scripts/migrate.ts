import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { getDatabaseConfig } from "@/lib/config";
import { createDb, createPool } from "@/lib/db/client";
import { envValue } from "@/lib/env";
import { importMovedVariables, logMovedVariables } from "@/lib/integrations/moved-variables";
import { currentSealingKey } from "@/lib/integrations/service";
import { errorMessage, logger } from "@/lib/logger";

// Applies the SQL migrations in drizzle/. Runs as the `migrate` service
// before `web` and `worker` start.
async function waitForDatabase(pool: Pool, attempts = 30): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.info({ attempt, error: errorMessage(error) }, "waiting for the database");
      await sleep(2_000);
    }
  }
}

async function main() {
  const pool = createPool(getDatabaseConfig().DATABASE_URL, "logbook-migrate");
  try {
    await waitForDatabase(pool);
    const migrationsFolder = envValue("MIGRATIONS_DIR") ?? path.resolve(process.cwd(), "drizzle");
    const db = createDb(pool);
    await migrate(db, { migrationsFolder });
    logger.info({ migrationsFolder }, "migrations applied");
    // Variables of Slack, email, and the webhook that this process sees go
    // to Admin › Integrations once (moved-variables.ts).
    logMovedVariables(await importMovedVariables(db, { key: currentSealingKey() }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "migration failed");
  process.exit(1);
});
