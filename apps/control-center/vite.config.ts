import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// The fleet version (repo-root package.json), so the page can show which build it runs.
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

export default defineConfig({
  base: "/control/",
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [tailwindcss()],
  // Workspace packages ship TypeScript sources under the "source" condition.
  resolve: { conditions: ["source", "module", "browser", "development|production"] },
  server: { host: "127.0.0.1", proxy: { "/control/api/v1": "http://127.0.0.1:8787" } },
});
