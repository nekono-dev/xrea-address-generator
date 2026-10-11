// Node.jsでの画面ファイルの配信。該当ファイルが無いパスは入口ファイルを返す。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Handler } from "hono"

/** 実行ファイルの位置から見た ../web（ビルド後の dist/web）。作業ディレクトリに依存しない */
export const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web")

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
}

// 名前に版を含む /assets/ は1年間キャッシュさせ、それ以外（入口・宣言・Service Worker）は毎回検証させる
export function staticHandler(webDir: string = DEFAULT_WEB_DIR): Handler {
  const assetsDir = path.join(webDir, "assets")
  return c => {
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "")
    const file = path.resolve(webDir, rel)
    const inside = file === webDir || file.startsWith(webDir + path.sep)
    const exists = inside && rel !== "" && fs.existsSync(file) && fs.statSync(file).isFile()
    // 存在しない /assets/ に入口を返すと、端末に入口が画面ファイルとして保存されるため 404 にする
    if (!exists && rel.startsWith("assets/")) return c.text("画面ファイルが見つかりません", 404, { "cache-control": "no-cache" })
    const target = exists ? file : path.join(webDir, "index.html")
    if (!fs.existsSync(target)) return c.text("画面ファイルが見つかりません", 404)
    const immutable = target.startsWith(assetsDir + path.sep)
    return c.body(fs.readFileSync(target), 200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    })
  }
}
