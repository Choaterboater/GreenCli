/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    // Only Vitest specs under src/; e2e/*.spec.ts belongs to Playwright and
    // throws "test() was called here" if Vitest's default glob picks it up.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const p = id.replace(/\\/g, "/"); // Windows build runners
          if (!p.includes("node_modules")) return;
          if (p.includes("monaco-editor") || p.includes("@monaco-editor")) return "monaco";
          if (p.includes("/node_modules/xterm")) return "xterm";
          // ONLY React itself goes in the react chunk. The old substring match
          // ("react" anywhere in the path) also captured react-markdown,
          // react-syntax-highlighter, lucide-react, … whose own dependencies
          // land in "vendor" — producing two chunks that import each other.
          // With circular chunks the evaluation order is import-graph luck;
          // when "vendor" ran first, React's exports were still undefined and
          // the app died at startup on a white screen.
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(p)) return "react-vendor";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
