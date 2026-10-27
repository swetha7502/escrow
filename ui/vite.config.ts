import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev/preview, /api and /events are proxied to the local control server (harness/server.ts), so the UI is
// same-origin and VITE_API_BASE can stay empty. A hosted build sets VITE_API_BASE / VITE_WS_URL instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.ESCROW_BACKEND ?? "http://127.0.0.1:8790";
  const proxy = { "/api": { target, changeOrigin: true }, "/events": { target: target.replace(/^http/, "ws"), ws: true, changeOrigin: true } };
  return {
    plugins: [react()],
    base: "./",
    server: { host: "127.0.0.1", port: 5173, proxy },
    preview: { host: "127.0.0.1", port: 4173, proxy },
    build: { chunkSizeWarningLimit: 1200 },
  };
});
