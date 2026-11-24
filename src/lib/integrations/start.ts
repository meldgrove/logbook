import { getDb } from "@/lib/db/client";
import { errorMessage, logger } from "@/lib/logger";
import { importMovedVariables, logMovedVariables } from "./moved-variables";
import { currentSealingKey } from "./service";

/** The web process's import of moved variables (moved-variables.ts). A failure is logged; the worker imports them too. */
export async function importAtStart(): Promise<void> {
  try {
    logMovedVariables(await importMovedVariables(getDb(), { key: currentSealingKey() }));
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, "could not copy settings from the environment to Admin › Integrations");
  }
}
