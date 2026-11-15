import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
    // Old v1 unit tests assume v1; v2 tests set BRAIN_PIPELINE=v2 themselves. The server default is v2 (server/src/report.ts).
    env: { BRAIN_PIPELINE: "v1" },
  },
});
