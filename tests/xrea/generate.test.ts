import { describe, expect, test } from "vitest"
import YAML from "yaml"
import { readSnapshot } from "../../scripts/xrea-docs/fetch"
import { ENDPOINTS, generate, mergePatch, parsePage, readOverlay } from "../../scripts/xrea-docs/generate"

const pages = readSnapshot()
const overlay = readOverlay()
type Doc = { paths: Record<string, any>; components: { schemas: Record<string, any> } }
const doc = (o = overlay) => YAML.parse(generate(pages, o)) as Doc
const reqSchema = (d: Doc, p: string) => d.paths[p].post.requestBody.content["application/x-www-form-urlencoded"].schema
const resSchema = (d: Doc, p: string) => d.paths[p].post.responses["200"].content["application/json"].schema

describe("宣言の生成", () => {
  test("xrea-client/AC-1: メール系3ページから、3エンドポイントとすべての必須項目を含む宣言を生成する", () => {
    const d = doc({})
    expect(Object.keys(d.paths).sort()).toEqual([...ENDPOINTS].sort())
    for (const p of ENDPOINTS) {
      expect(reqSchema(d, p).required).toEqual(expect.arrayContaining(["account", "server_name", "api_secret_key"]))
    }
    // ドキュメントで「○」の付いたメール作成の必須項目
    expect(d.components.schemas.v1_mail_edit_param.required).toEqual(
      expect.arrayContaining(["address_name", "address_domain", "address", "pop_how", "quota", "autorespond", "clamd", "spamd", "customd"]),
    )
    expect(Object.keys(resSchema(d, "/v1/mail/list").properties)).toEqual(expect.arrayContaining(["result", "status_code"]))
  })

  test("xrea-client/AC-2: 補正定義で上書きした項目が宣言に反映される", () => {
    const before = doc({})
    const after = doc()
    expect(before.components.schemas.v1_mail_list_response_result.properties.quota.type).toBe("integer")
    expect(after.components.schemas.v1_mail_list_response_result.properties.quota.type).toBe("string")
    // 番号をキーとするオブジェクトへの変換と、reset_flg の 0 固定
    expect(resSchema(after, "/v1/mail/list").properties.result.additionalProperties.$ref).toBe(
      "#/components/schemas/v1_mail_list_response_result",
    )
    expect(reqSchema(after, "/v1/mail/edit").properties.reset_flg.enum).toEqual([0])
    // 任意の補正（ここではテスト用の上書き）も同じ仕組みで反映される
    const custom = doc({ components: { schemas: { v1_mail_edit_param: { properties: { quota: { type: "string" } } } } } })
    expect(custom.components.schemas.v1_mail_edit_param.properties.quota.type).toBe("string")
  })

  test("xrea-client/AC-11: 2回続けて生成した出力がバイト単位で一致する", () => {
    expect(generate(pages, overlay)).toBe(generate(pages, overlay))
  })
})

describe("ページの読み取りと補正の適用", () => {
  test("値の無い行をグループの見出しとして、後続の行を子にする", () => {
    const html = `<h2 id="request">Request</h2><p><code>POST /v1/mail/delete</code></p>
      <table><tbody>
        <tr><td>account</td><td>x</td><td>string</td><td>無し</td><td>○</td><td></td></tr>
        <tr><td>param</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><td>no</td><td>1〜999</td><td>array</td><td>無し</td><td>✕</td><td>no</td></tr>
      </tbody></table>`
    const p = parsePage(html)
    expect(p.endpoint).toBe("/v1/mail/delete")
    expect(p.request.map(f => f.key)).toEqual(["account", "param"])
    expect(p.request[1]!.children!.map(f => f.key)).toEqual(["no"])
    expect(p.request[0]!.required).toBe(true)
  })

  test("表の読み取れないページは、ページ名を示して中止する", () => {
    expect(() => parsePage("<p>なし</p>", "broken.html")).toThrow("broken.html")
  })

  test("JSON Merge Patch は null でキーを削除し、それ以外を再帰的に上書きする", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { a: null, b: { c: 9 } })).toEqual({ b: { c: 9, d: 3 } })
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  })
})
