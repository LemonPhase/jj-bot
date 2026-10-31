import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ are separate checkouts with their own suites;
    // excluding them keeps a run from the main checkout identical to CI.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // PGlite-backed suites take several seconds per test on loaded machines and
    // CI runners; vitest's 5 s default made them flaky.
    testTimeout: 20_000,
  },
});
