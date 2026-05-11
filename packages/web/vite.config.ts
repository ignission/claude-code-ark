import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const plugins = [react(), tailwindcss()];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@ark/shared": path.resolve(
        import.meta.dirname,
        "../shared/src/types.ts"
      ),
    },
  },
  envDir: path.resolve(import.meta.dirname, "../.."),
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 4000,
    strictPort: false, // Will find next available port if 4000 is busy
    host: true,
    allowedHosts: ["localhost", "127.0.0.1"],
    // APIとSocket.IOをバックエンドにプロキシ
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
      "/socket.io": {
        target: process.env.VITE_API_URL || "http://localhost:4001",
        ws: true,
        changeOrigin: true,
      },
      "/ttyd": {
        target: process.env.VITE_API_URL || "http://localhost:4001",
        ws: true,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
