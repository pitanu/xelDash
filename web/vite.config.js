import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on its published host port; in Compose, nginx proxies /api.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": process.env.XELDASH_API_URL ?? "http://127.0.0.1:8081" },
  },
});
