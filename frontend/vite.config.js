// DocuProcess Cloud frontend Vite config: dev/preview servers on fixed ports
// with an /api proxy to the local API, and a clean dist/ on build.
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const proxy = {
    "/api": {
      target: env.VITE_API_PROXY_TARGET || "http://localhost:8000",
      changeOrigin: true,
    },
  };

  return {
    server: {
      host: "127.0.0.1",
      port: 5500,
      strictPort: true,
      proxy,
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
