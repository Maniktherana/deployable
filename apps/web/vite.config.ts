import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackRouter } from "@tanstack/router-plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * In local dev (`bun run dev`) the API runs on a different port (4000 by
 * default). Proxying `/api` here lets the frontend code call `/api/...`
 * unconditionally — the same paths work in compose/prod via Caddy.
 *
 * Override the upstream with `VITE_DEV_API_PROXY=http://host:port` if needed.
 */
const apiUpstream = process.env.VITE_DEV_API_PROXY ?? "http://127.0.0.1:4000";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
  ],
  server: {
    proxy: {
      "/api": {
        target: apiUpstream,
        changeOrigin: true,
        ws: true,
        // SSE streams need the proxy not to buffer.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("X-Forwarded-Host", "localhost");
          });
        },
      },
    },
  },
});

export default config;
