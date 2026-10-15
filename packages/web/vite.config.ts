import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// ビルドごとに変わる目印。配信中の版が新しくなったことを、開いている画面が
// 知るのに使う (`src/lib/build-version.ts`)。dev では起動中ずっと同じ値にする
// (リクエストごとに変えると、開いている画面が読み込み直しを繰り返す)
const BUILD_ID = Date.now().toString(36);
const buildIdPlugin: Plugin = {
  name: "ark-build-id",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { name: "ark-build", content: BUILD_ID },
      injectTo: "head",
    },
  ],
};

const plugins = [react(), tailwindcss(), buildIdPlugin];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
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
      "/screen": {
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
