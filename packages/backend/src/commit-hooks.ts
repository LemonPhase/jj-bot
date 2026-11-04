// Work that waits for a commit, such as a metric counting what a write
// stored: `afterCommit(tx, fn)` runs `fn` once the engine transaction `tx`
// belongs to has committed, and never when it rolls back. A transaction the
// engine's database did not open (a test's own, a nested savepoint) runs it
// at once.
import type { Db, Tx } from "@jj/db";

const pending = new WeakMap<Tx, (() => void)[]>();

export function afterCommit(tx: Tx, fn: () => void): void {
  const hooks = pending.get(tx);
  if (hooks) hooks.push(fn);
  else fn();
}

/**
 * `db` with a `transaction` that runs its transactions' `afterCommit` hooks
 * once they commit. Everything else is `db` itself (its prototype).
 */
export function withCommitHooks(db: Db): Db {
  const hooked = Object.create(db) as Db;
  hooked.transaction = (async (
    fn: (tx: Tx) => Promise<unknown>,
    config?: Parameters<Db["transaction"]>[1],
  ) => {
    let hooks: (() => void)[] = [];
    const result = await db.transaction(async (tx) => {
      hooks = [];
      pending.set(tx, hooks);
      return fn(tx);
    }, config);
    for (const hook of hooks) hook();
    return result;
  }) as Db["transaction"];
  return hooked;
}
