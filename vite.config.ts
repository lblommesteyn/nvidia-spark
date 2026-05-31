import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 3100,
    // Listen on all interfaces so others on the same LAN can reach the app at
    // http://<your-LAN-IP>:3100. The frontend uses relative /api paths, which
    // Vite proxies to the local backend below, so only this server needs to be
    // exposed — the API can stay bound to localhost.
    host: true,
    allowedHosts: ["armband-ravioli-crayfish.ngrok-free.dev"],
    proxy: {
      // Forward API calls to the in-repo Node backend during development.
      // SSE endpoints (/api/agent/stream, /api/alerts/stream) need buffering
      // disabled so tokens arrive in real time instead of being held until the
      // connection closes.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        // Disable Vite's response buffering for SSE streams.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, req) => {
            if (req.url?.includes("/stream")) {
              proxyRes.headers["x-accel-buffering"] = "no";
              proxyRes.headers["cache-control"] = "no-cache";
            }
          });
        },
      },
    },
    watch: {
      // Don't watch the Python venv / training artifacts / data living in-repo;
      // they contain tens of thousands of files and exhaust the inotify limit
      // (ENOSPC: System limit for number of file watchers reached).
      ignored: [
        "**/.venv/**",
        "**/out/**",
        "**/data/**",
        "**/__pycache__/**",
        "**/*.jsonl",
      ],
    },
  },
});
