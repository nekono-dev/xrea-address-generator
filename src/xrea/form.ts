// リクエスト項目をフォーム形式（インデックス付きの項目名）へ平坦化する。
// 例: { param: [{ address_name: "a" }] } -> param[0][address_name]=a
//     { param: { no: [3] } }             -> param[no][0]=3

export type FormValue = string | number | boolean | null | undefined | FormObject | FormValue[]
export type FormObject = { [key: string]: FormValue }

export function flatten(obj: FormObject | FormValue[], prefix = "", out: [string, string][] = []): [string, string][] {
  const entries: [string, FormValue][] = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj)
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue
    const key = prefix === "" ? k : `${prefix}[${k}]`
    if (typeof v === "object") flatten(v, key, out)
    else out.push([key, String(v)])
  }
  return out
}

export function toFormBody(obj: FormObject): URLSearchParams {
  const body = new URLSearchParams()
  for (const [k, v] of flatten(obj)) body.append(k, v)
  return body
}
