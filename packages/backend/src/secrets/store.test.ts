import { randomBytes } from "node:crypto";
import { type Executor, retiredSecrets, type SecretRow } from "@jj/db";
import { describe, expect, it } from "vitest";
import { createKeyring } from "./keyring";
import { SecretStore } from "./store";

/**
 * An executor whose reads of the secrets table resolve when the test says;
 * the retired values' table reads empty at once.
 */
function controlledReads() {
  const pending: ((rows: SecretRow[]) => void)[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          table === retiredSecrets
            ? Promise.resolve([])
            : new Promise<SecretRow[]>((resolve) => pending.push(resolve)),
      }),
    }),
  } as unknown as Executor;
  return { db, pending };
}

describe("SecretStore.refresh", () => {
  it("never lets an older read replace a newer snapshot", async () => {
    const keyring = createKeyring(randomBytes(32));
    const { db, pending } = controlledReads();
    const store = new SecretStore({ db, keyring });
    const row = (value: string, at: number): SecretRow => {
      const sealed = store.seal("sandbox", "GH_TOKEN", value);
      return {
        ownerId: store.owner,
        kind: "sandbox",
        name: "GH_TOKEN",
        keyId: sealed.keyId,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        hint: sealed.hint,
        createdAt: new Date(0),
        updatedAt: new Date(at),
      };
    };
    const older = store.refresh();
    const newer = store.refresh();
    expect(pending).toHaveLength(2);
    // The later read (after a write) answers first, the earlier one last.
    pending[1]?.([row("ghp_newValue0123456789abcdNEWW", 2)]);
    await newer;
    pending[0]?.([row("ghp_oldValue0123456789abcdOLDD", 1)]);
    await older;
    expect(store.sandboxSecrets().map((secret) => secret.hint)).toEqual([
      "NEWW",
    ]);
    expect(store.values().map((secret) => secret.value)).toEqual([
      "ghp_newValue0123456789abcdNEWW",
    ]);
    // A read that starts later still applies.
    const latest = store.refresh();
    pending[2]?.([]);
    await latest;
    expect(store.sandboxSecrets()).toEqual([]);
  });
});
