import { afterAll, describe, expect, it } from "vitest";
import { instanceSetting } from "./settings";
import { cleanup, OPEN_TIMEOUT, targets } from "./test-helpers";

afterAll(cleanup, OPEN_TIMEOUT);

describe.each(targets)("instanceSetting ($name)", (target) => {
  it(
    "creates a value once and returns the stored one afterwards",
    async () => {
      const fresh = await target.fresh();
      const database = await fresh.open();
      let made = 0;
      const initial = () => `value-${++made}`;
      expect(await instanceSetting(database.db, "k", initial)).toEqual({
        value: "value-1",
        created: true,
      });
      expect(await instanceSetting(database.db, "k", initial)).toEqual({
        value: "value-1",
        created: false,
      });
      expect(await instanceSetting(database.db, "other", initial)).toEqual({
        value: "value-2",
        created: true,
      });
    },
    OPEN_TIMEOUT,
  );

  it(
    "agrees on one value under concurrent first calls",
    async () => {
      const fresh = await target.fresh();
      const database = await fresh.open(8);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          instanceSetting(database.db, "race", () => `candidate-${index}`),
        ),
      );
      expect(new Set(results.map((result) => result.value)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    },
    OPEN_TIMEOUT,
  );
});
