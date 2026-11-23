/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The editor chunk (CodeMirror + pdf.js) is large but lazy-loaded; the landing page stays small.
  build: { chunkSizeWarningLimit: 1600 },
  server: {
    port: 5174,
    proxy: { "/api": { target: "http://localhost:8001", ws: true } },
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
