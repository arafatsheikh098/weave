import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "crdt", include: ["test/**/*.test.ts"] } });
