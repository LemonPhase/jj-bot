import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ are separate checkouts with their own suites;
    // excluding them keeps a run from the main checkout identical to CI.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // PGlite-backed suites take several seconds per test on loaded machines and
    // CI runners; vitest's 5 s default made them flaky. Hooks that boot PGlite
    // (often per test) hit the 10 s hook default the same way.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
