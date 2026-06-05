import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Dev: Vite serves the Solid app with HMR and proxies API/auth calls to the
// Hono server (single browser origin → Origin/CSRF behave like prod).
// Prod (V6): `vite build` emits dist/, served by Hono's serveStatic.
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8888", changeOrigin: true },
      "/auth": { target: "http://127.0.0.1:8888", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
