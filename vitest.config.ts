import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Property tests sweep many seeds; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
  },
});
