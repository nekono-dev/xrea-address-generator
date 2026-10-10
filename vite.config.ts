import path from "node:path"
import preact from "@preact/preset-vite"
import { defineConfig } from "vite"

export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      // Service Worker は版を含まない固定の名前で、入口と同じ階層に書き出す
      input: { main: path.resolve(import.meta.dirname, "web/index.html"), sw: path.resolve(import.meta.dirname, "web/src/sw/sw.ts") },
      output: { entryFileNames: c => (c.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
  server: {
    // 開発時はAPIをローカルのサーバへ転送する
    proxy: { "/api": "http://127.0.0.1:3000", "/healthz": "http://127.0.0.1:3000" },
  },
  preview: { port: 4173, strictPort: true },
})
