import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "server", include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000 },
});
