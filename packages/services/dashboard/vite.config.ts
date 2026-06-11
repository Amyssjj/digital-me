import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Both port and proxy target are env-driven so the NUX rewrite can boot
// side-by-side with the launchd-managed legacy mission-control on :3456
// without port conflicts. Defaults match server.ts so `pnpm dashboard`
// works zero-config — no env vars required for the common case.
const port = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 3457;
// Target 127.0.0.1 explicitly, not "localhost". Node ≥17 resolves "localhost"
// verbatim and prefers the IPv6 record (::1); if the API server only bound the
// IPv4 wildcard, a "localhost" target would make every /api proxy hop hit
// ::1:3458 and fail with ECONNREFUSED — leaving the dashboard with no data.
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3458";

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    host: true,
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
});
