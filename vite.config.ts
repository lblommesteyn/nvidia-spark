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
    proxy: {
      // Forward API calls to the in-repo Node backend during development.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
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
