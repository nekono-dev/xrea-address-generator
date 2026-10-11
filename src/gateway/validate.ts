// 発行の入力の検証。
export type CreateInput = { name?: string; domain: string; forwardTo: string }

/** 1〜49文字。XREAは50文字以上を拒否する。先頭と末尾は英数字 */
export const NAME_RE = /^[a-z0-9]([a-z0-9._-]{0,47}[a-z0-9])?$/
/** 小文字のドメイン名。2ラベル以上で、各ラベルは英数字とハイフン（先頭と末尾は英数字）。日本語ドメインはpunycodeで指定する */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
export const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 名前は小文字に正規化してから検証する（XREAも小文字で保存する） */
export const normalizeName = (name: string): string => name.trim().toLowerCase()

/** 違反の説明の配列を返す。空なら入力は正しい */
export function validate(input: CreateInput): string[] {
  const errors: string[] = []
  const name = input.name === undefined ? "" : normalizeName(input.name)
  if (name !== "" && (!NAME_RE.test(name) || name.includes("..")))
    errors.push("名前は英小文字・数字・. _ - の1〜49文字で、先頭と末尾は英数字、ピリオドは連続できません")
  if (typeof input.domain !== "string" || !DOMAIN_RE.test(input.domain.trim().toLowerCase())) errors.push("ドメインはドメイン名の形式で指定してください")
  if (typeof input.forwardTo !== "string" || !MAIL_RE.test(input.forwardTo.trim())) errors.push("転送先はメールアドレスの形式で指定してください")
  return errors
}
