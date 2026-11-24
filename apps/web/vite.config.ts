/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Writes dist/precache.json: every emitted file, so the service worker can cache them all. */
function precacheManifest(): Plugin {
  return {
    name: "weave-precache-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "index.html");
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify(files) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precacheManifest()],
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
