// 例外型とエラー応答の変換、一覧応答の正規化。
import type { components } from "./generated/schema"

export type XreaErrorKind = "api" | "rate_limit" | "timeout" | "network"

export class XreaError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly kind: XreaErrorKind,
  ) {
    super(message)
    this.name = "XreaError"
  }
}

type Envelope<T> = { status_code: number; message?: string; result?: T }

/** status_code が 200 以外ならエラー。message が空のときは送信間隔の超過として扱う */
export function toResult<T>(res: Envelope<T>): T | undefined {
  if (res.status_code === 200) return res.result
  const message = (res.message ?? "").trim()
  if (message === "") throw new XreaError(res.status_code, "XREAへのリクエストが送信間隔の上限を超えました", "rate_limit")
  throw new XreaError(res.status_code, message, "api")
}

export type RawMailEntry = components["schemas"]["v1_mail_list_response_result"]
/** パスワード項目を取り除いたメールアドレスの情報 */
export type MailEntry = Omit<RawMailEntry, "pop_pass">

/** パスワード項目を取り除く */
export function omitSecret({ pop_pass: _secret, ...rest }: RawMailEntry): MailEntry {
  return rest
}

/** 番号をキーとするオブジェクトを、番号の昇順の配列にする */
export function sortedEntries(raw: Record<string, RawMailEntry> | undefined): RawMailEntry[] {
  return Object.values(raw ?? {}).sort((a, b) => a.no - b.no)
}

/** 番号の昇順の配列にし、パスワード項目を取り除く */
export function normalizeList(raw: Record<string, RawMailEntry> | undefined): MailEntry[] {
  return sortedEntries(raw).map(omitSecret)
}
