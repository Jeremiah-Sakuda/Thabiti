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
    // Property tests sweep many seeds; the gated Aurora integration suite also
    // makes many round-trips to a remote cluster — give both room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "threads",
  },
});
