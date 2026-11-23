import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/crdt", "packages/protocol", "apps/server", "apps/web"],
  },
});
