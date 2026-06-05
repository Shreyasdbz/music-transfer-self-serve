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
      // changeOrigin rewrites the Host header to the target; `headers.Origin`
      // forces the Origin to the server's expected value so the §11.0
      // Host+Origin+CSRF checks pass through the dev proxy (the page is served
      // from :5173 but the API lives on :8888).
      "/api": {
        target: "http://127.0.0.1:8888",
        changeOrigin: true,
        headers: { Origin: "http://127.0.0.1:8888" },
      },
      "/auth": {
        target: "http://127.0.0.1:8888",
        changeOrigin: true,
        headers: { Origin: "http://127.0.0.1:8888" },
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
