// 保存した公式ドキュメントから OpenAPI 3.1 の宣言を生成し、補正定義（JSON Merge Patch）を適用する。
// 使い方: tsx scripts/xrea-docs/generate.ts  （api/xrea.openapi.yaml を書き出す）
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse, type HTMLElement } from "node-html-parser"
import YAML from "yaml"
import { PAGES, readSnapshot } from "./fetch"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const OVERLAY_FILE = path.join(ROOT, "api/overlay.yaml")
export const OUTPUT_FILE = path.join(ROOT, "api/xrea.openapi.yaml")

/** 生成対象のエンドポイント（許可リスト） */
export const ENDPOINTS = ["/v1/mail/list", "/v1/mail/edit", "/v1/mail/delete"] as const

export type Field = {
  key: string
  value: string
  type: string
  def: string
  required: boolean
  desc: string
  children?: Field[]
}
export type ParsedPage = {
  endpoint: string
  request: Field[]
  response: Field[]
  defs: Record<string, Field[]>
}

type Schema = Record<string, unknown>
type Overlay = Record<string, unknown>

const clean = (s: string): string => s.replace(/\s+/g, " ").trim()

/** 1ページを読み取り、エンドポイントと、リクエスト・レスポンス・補助定義の項目を返す */
export function parsePage(html: string, page = "(不明なページ)"): ParsedPage {
  const root = parse(html)
  const endpoint = /POST\s+(\/v1\/[a-z_/]+)/.exec(root.text)?.[1]
  if (!endpoint) throw new Error(`エンドポイントを読み取れません: ${page}`)

  const result: ParsedPage = { endpoint, request: [], response: [], defs: {} }
  let section: "request" | "response" | null = null
  let defName: string | null = null
  let header: Field | null = null // 値の無い行（グループの見出し）。後続の行はその子になる

  for (const node of root.childNodes) {
    const el = node as HTMLElement
    const tag = el.tagName?.toLowerCase()
    if (!tag) continue
    if (tag === "h2") {
      const id = el.getAttribute("id")
      section = id === "request" ? "request" : id === "response" ? "response" : section
      defName = null
      header = null
    } else if (tag === "h3") {
      const m = /^下記\s*(\S+)/.exec(clean(el.text))
      defName = m?.[1] ?? null
      header = null
    } else if (tag === "table" && section) {
      const target = defName ? (result.defs[defName] ??= []) : result[section]
      for (const tr of el.querySelectorAll("tbody tr")) {
        const cells = tr.querySelectorAll("td").map(td => clean(td.text))
        if (cells.length < 6) throw new Error(`表の行を読み取れません: ${page}（${cells.join("|")}）`)
        const [key, value, type, def, req, desc] = cells as [string, string, string, string, string, string]
        if (!key) continue
        if (!value && !type && !def && !req && !desc) {
          header = { key, value: "", type: "object", def: "", required: false, desc: "", children: [] }
          target.push(header)
          continue
        }
        const field: Field = { key, value, type, def, required: /[○◯]/.test(req), desc }
        if (header) header.children!.push(field)
        else target.push(field)
      }
    }
  }
  if (result.request.length === 0) throw new Error(`リクエストの表を読み取れません: ${page}`)
  return result
}

function leafSchema(f: Field): Schema {
  const type = f.type === "int" ? "integer" : f.type === "array" ? "array" : "string"
  const s: Schema = { type }
  if (type === "array") s.items = { type: "string" }
  if (f.desc) s.description = f.desc
  if (/^[\w.-]+(\|[\w.-]+)+$/.test(f.value)) {
    const vals = f.value.split("|")
    s.enum = type === "integer" ? vals.map(Number) : vals
  } else if (f.value) s.examples = [f.value]
  if (f.def && f.def !== "無し") s.default = type === "integer" ? Number(f.def) : f.def
  return s
}

/** 項目の配列をオブジェクトのスキーマへ変換する。グループと補助定義は components へ出す */
function toObjectSchema(fields: Field[], scope: string, defs: Record<string, Field[]>, components: Record<string, Schema>): Schema {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  for (const f of fields) {
    const name = `${scope}_${f.key}`
    if (f.children) {
      components[name] = toObjectSchema(f.children, name, defs, components)
      properties[f.key] = { $ref: `#/components/schemas/${name}` }
    } else if (defs[f.key]) {
      components[name] = toObjectSchema(defs[f.key]!, name, defs, components)
      properties[f.key] = { type: "array", items: { $ref: `#/components/schemas/${name}` }, ...(f.desc ? { description: f.desc } : {}) }
    } else {
      properties[f.key] = leafSchema(f)
    }
    if (f.required) required.push(f.key)
  }
  const s: Schema = { type: "object", properties }
  if (required.length) s.required = [...required].sort()
  return s
}

/** RFC 7386 の JSON Merge Patch を適用する（null はキーの削除） */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch
  const base: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k]
    else base[k] = mergePatch(base[k], v)
  }
  return base
}

/** 宣言（YAML文字列）を生成する。日時・乱数・環境依存の値は含めない */
export function generate(pages: Map<string, string>, overlay: Overlay): string {
  const components: Record<string, Schema> = {}
  const paths: Record<string, unknown> = {}
  for (const page of PAGES) {
    const html = pages.get(page)
    if (html === undefined) throw new Error(`基準のページがありません: ${page}`)
    const p = parsePage(html, page)
    if (!(ENDPOINTS as readonly string[]).includes(p.endpoint)) continue
    const opId = p.endpoint.replace(/^\//, "").replaceAll("/", "_")
    const request = toObjectSchema(p.request, opId, p.defs, components)
    const response = toObjectSchema(p.response, `${opId}_response`, p.defs, components)
    ;(response.properties as Record<string, Schema>).status_code = { type: "integer", enum: [200, 500] }
    ;(response.properties as Record<string, Schema>).message = { type: "string" }
    response.required = [...new Set([...((response.required as string[]) ?? []), "status_code"])].sort()
    paths[p.endpoint] = {
      post: {
        operationId: opId,
        requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: request } } },
        responses: { "200": { description: "OK", content: { "application/json": { schema: response } } } },
      },
    }
  }
  const doc = {
    openapi: "3.1.0",
    info: { title: "XREA API（メール）", version: "1" },
    servers: [{ url: "https://api.xrea.com" }],
    paths,
    components: { schemas: components },
  }
  const patched = mergePatch(doc, overlay)
  return YAML.stringify(patched, { sortMapEntries: true, lineWidth: 0 })
}

export function readOverlay(file: string = OVERLAY_FILE): Overlay {
  return (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as Overlay
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const out = generate(readSnapshot(), readOverlay())
    fs.writeFileSync(OUTPUT_FILE, out)
    console.log(`宣言を生成しました: ${path.relative(ROOT, OUTPUT_FILE)}`)
  } catch (e) {
    // 生成を中止し、出力ファイルは変更しない
    console.error((e as Error).message)
    process.exitCode = 1
  }
}
