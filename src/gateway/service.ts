// 一覧、発行、転送先の変更、削除、候補の導出。アプリ独自のデータは保存せず、XREAの一覧から導き出す。
import { AppError } from "../shared/errors"
import type { CreateMailInput, ForwardCheck } from "../xrea/client"
import type { MailEntry } from "../xrea/errors"
import type { DomainCheck } from "./domainCheck"
import type { Tenant } from "./registry"
import { randomName } from "./randomName"
import { MAIL_RE, normalizeName, validate, type CreateInput } from "./validate"
import { WORDS } from "./words"

/** mailbox は、メールボックスを持つ（受信のみ・転送と受信の両方の）アドレス。表示だけで、変更・削除はできない */
export type GatewayAlias = { address: string; name: string; domain: string; forwardTo: string; mailbox: boolean }

export type XreaPort = {
  mailList(): Promise<MailEntry[]>
  mailCreate(input: CreateMailInput): Promise<void>
  mailChangeForward(address: string, forwardTo: string, check: ForwardCheck): Promise<void>
  mailRemoveForward(address: string, check: ForwardCheck): Promise<void>
  mailDelete(nos: number[]): Promise<void>
}

const FORWARD_ONLY = 1
const MAILBOX_KINDS = [2, 3] // 受信のみ・転送と受信の両方
const MAX_RANDOM_TRIES = 5
const addressOf = (m: { address_name: string; address_domain: string }) => `${m.address_name}@${m.address_domain}`.toLowerCase()

/** 応答に載せるのは5項目のみ。MailEntry を直接返さない */
function toGatewayAlias(m: Pick<MailEntry, "address_name" | "address_domain" | "address_trans"> & { pop_how?: number }): GatewayAlias {
  return {
    address: addressOf(m),
    name: m.address_name,
    domain: m.address_domain,
    forwardTo: m.address_trans ?? "",
    mailbox: MAILBOX_KINDS.includes(m.pop_how ?? FORWARD_ONLY),
  }
}

export async function listAliases(t: Tenant): Promise<GatewayAlias[]> {
  const mails = await t.cache.get()
  return mails
    .filter(m => m.pop_how === FORWARD_ONLY || MAILBOX_KINDS.includes(m.pop_how)) // 破棄以外を残す
    .map(toGatewayAlias)
    .sort((a, b) => a.address.localeCompare(b.address))
}

export function deriveOptions(mails: readonly MailEntry[]): { domains: string[]; forwardTargets: string[] } {
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((s): s is string => !!s).map(s => s.toLowerCase()))].sort()
  return { domains: uniq(mails.map(m => m.address_domain)), forwardTargets: uniq(mails.map(m => m.address_trans)) }
}

export async function options(t: Tenant) {
  return deriveOptions(await t.cache.get())
}

export function createAlias(t: Tenant, input: CreateInput, deps: { words?: readonly string[]; rnd?: () => number; domainCheck: DomainCheck }): Promise<GatewayAlias> {
  return t.mutex.run(async () => {
    const mails = await t.cache.fresh()
    const errors = validate(input)
    if (errors.length) throw new AppError("validation_error", errors.join("。"))

    const domain = input.domain.trim().toLowerCase()
    // 候補にあるドメインは確認しない。ないドメインは、XREAが未登録でも受理するため、MXで確かめる
    if (!deriveOptions(mails).domains.includes(domain)) await deps.domainCheck(domain, t.serverName)
    const forwardTo = input.forwardTo.trim()
    const existing = new Set(mails.map(addressOf))
    let name = input.name === undefined ? "" : normalizeName(input.name)
    if (name === "") {
      for (let i = 0; i < MAX_RANDOM_TRIES && (name === "" || existing.has(`${name}@${domain}`)); i++)
        name = randomName(deps.words ?? WORDS, deps.rnd)
    }
    if (existing.has(`${name}@${domain}`)) throw new AppError("conflict", `${name}@${domain} はすでに存在します`)

    await t.xrea.mailCreate({ name, domain, forwardTo })
    t.cache.invalidate()
    return toGatewayAlias({ address_name: name, address_domain: domain, address_trans: forwardTo })
  })
}

export function changeForward(t: Tenant, address: string, forwardTo: string): Promise<GatewayAlias> {
  const to = forwardTo.trim()
  if (!MAIL_RE.test(to)) return Promise.reject(new AppError("validation_error", "転送先はメールアドレスの形式で指定してください"))
  return t.mutex.run(async () => {
    let target: MailEntry | undefined
    // 一覧の取り直し・アドレスの解決・送信はクライアントが続けて行う（番号のずれを防ぐ）
    await t.xrea.mailChangeForward(address.trim(), to, m => {
      if (!m) throw new AppError("not_found", `${address} は存在しません`)
      if (![FORWARD_ONLY, ...MAILBOX_KINDS].includes(m.pop_how)) throw new AppError("forbidden", "このアドレスの転送先は変更できません")
      target = m
    })
    t.cache.invalidate()
    // 受信のみのアドレスは、転送の追加で両方になる
    return toGatewayAlias({ ...target!, pop_how: target!.pop_how === 2 ? 3 : target!.pop_how, address_trans: to })
  })
}

export function removeForward(t: Tenant, address: string): Promise<GatewayAlias> {
  return t.mutex.run(async () => {
    let target: MailEntry | undefined
    await t.xrea.mailRemoveForward(address.trim(), m => {
      if (!m) throw new AppError("not_found", `${address} は存在しません`)
      if (m.pop_how !== 3) throw new AppError("forbidden", "転送を解除できるのは、転送と受信の両方のアドレスだけです")
      target = m
    })
    t.cache.invalidate()
    return toGatewayAlias({ ...target!, pop_how: 2, address_trans: "" })
  })
}

export function deleteAlias(t: Tenant, address: string): Promise<void> {
  return t.mutex.run(async () => {
    const mails = await t.cache.fresh() // 取り直した一覧
    const target = mails.find(m => addressOf(m) === address.trim().toLowerCase())
    if (!target) throw new AppError("not_found", `${address} は存在しません`)
    if (target.pop_how !== FORWARD_ONLY) throw new AppError("forbidden", "転送のみのアドレス以外は削除できません")
    await t.xrea.mailDelete([target.no]) // 直前の一覧の番号だけを使う
    t.cache.invalidate()
  })
}
