// アイコンの原画（web/icon.svg）から、宣言とiOS用のアイコンをヘッドレスブラウザで書き出す。
// 実行: npx tsx scripts/icons.ts（書き出したファイルはリポジトリに含める）
import fs from "node:fs"
import path from "node:path"
import { chromium } from "@playwright/test"

const root = path.resolve(import.meta.dirname, "..")
const svg = fs.readFileSync(path.join(root, "web/icon.svg"), "utf8")
const OUT = path.join(root, "web/public/icons")
const ICONS = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
]

const browser = await chromium.launch()
try {
  fs.mkdirSync(OUT, { recursive: true })
  for (const { file, size } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    await page.setContent(`<style>html,body{margin:0;background:#0f172a}</style><img src="${src}" width="${size}" height="${size}" style="display:block">`)
    await page.locator("img").evaluate(img => (img as HTMLImageElement).decode())
    fs.writeFileSync(path.join(OUT, file), await page.screenshot({ type: "png", omitBackground: false }))
    await page.close()
    console.log(`書き出しました: web/public/icons/${file}（${size}×${size}）`)
  }
} finally {
  await browser.close()
}
