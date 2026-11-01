import { eq } from "drizzle-orm";
import type { Executor } from "./database";
import { instanceSettings } from "./schema";

/**
 * The instance setting `key`, created with `initial()` when it does not exist
 * yet. The first writer wins: later and concurrent callers, other processes
 * on the same PostgreSQL database included, all get the stored value.
 * `created` is true only for the call that stored it.
 */
export async function instanceSetting(
  exec: Executor,
  key: string,
  initial: () => string,
): Promise<{ value: string; created: boolean }> {
  const stored = async () => {
    const [row] = await exec
      .select({ value: instanceSettings.value })
      .from(instanceSettings)
      .where(eq(instanceSettings.key, key));
    return row?.value;
  };
  const existing = await stored();
  if (existing !== undefined) return { value: existing, created: false };
  const [inserted] = await exec
    .insert(instanceSettings)
    .values({ key, value: initial() })
    .onConflictDoNothing({ target: instanceSettings.key })
    .returning({ value: instanceSettings.value });
  if (inserted) return { value: inserted.value, created: true };
  const raced = await stored();
  if (raced === undefined)
    throw new Error(`Instance setting ${key} vanished while it was created.`);
  return { value: raced, created: false };
}
