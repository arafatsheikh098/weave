import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "compile", include: ["src/**/*.test.mjs"] } });
