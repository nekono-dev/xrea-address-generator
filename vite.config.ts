import preact from "@preact/preset-vite"
import { defineConfig } from "vite"

export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    // 開発時はAPIをローカルのサーバへ転送する
    proxy: { "/api": "http://127.0.0.1:3000", "/healthz": "http://127.0.0.1:3000" },
  },
  preview: { port: 4173, strictPort: true },
})
