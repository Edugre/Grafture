import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@schema-studio/core": path.resolve(rootDir, "../../packages/core/src/index.ts"),
    },
  },
  server: {
    port: 5173,
  },
});
