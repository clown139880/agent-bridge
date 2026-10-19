import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/control/",
  plugins: [tailwindcss()],
  server: { host: "127.0.0.1", proxy: { "/api/v1": "http://127.0.0.1:8787" } },
});
