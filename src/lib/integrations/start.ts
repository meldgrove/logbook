import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db/client";
import { appSetting } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import { seal, urlHint, type SealingKey } from "./crypto";
import { currentSealingKey } from "./service";
import { loadStored, lockIntegrations, SECRET_FIELDS } from "./store";

/** Seals a webhook URL that 0.3.3 saved as plain text. Returns whether there was one. */
export async function sealWebhookUrl(db: Database, key: SealingKey): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockIntegrations(tx);
    const { webhook } = (await loadStored(tx)).stored;
    if (typeof webhook.url !== "string") return false;
    const url = { sealed: seal(key, SECRET_FIELDS.webhookUrl, webhook.url), hint: urlHint(webhook.url) };
    await tx.update(appSetting).set({ value: { ...webhook, url } }).where(eq(appSetting.key, "webhook"));
    return true;
  });
}

/** Run by each process that starts with the key (web, worker). A failure is logged: a plain URL still works. */
export async function sealAtStart(): Promise<void> {
  try {
    const key = currentSealingKey();
    if (key && (await sealWebhookUrl(getDb(), key))) logger.info("the saved webhook URL is now encrypted");
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, "could not encrypt the saved webhook URL");
  }
}
