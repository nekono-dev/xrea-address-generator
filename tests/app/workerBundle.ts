// Workers向けの成果物をメモリ上に作る（ビルドの npm スクリプトと同じ設定）。
import { build } from "esbuild"

export async function bundleWorker(): Promise<string> {
  const out = await build({
    entryPoints: ["src/app/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser", // node: の組み込みモジュールを含めるとここで失敗する
    conditions: ["workerd", "worker", "browser"],
    minify: true,
    write: false,
    logLevel: "silent",
  })
  return out.outputFiles[0]!.text
}
