// 一覧の合成、発行、転送先の変更、削除、候補の導出。アプリ独自のデータは保存せず、XREAとProton Passから導き出す。
import type { AddressMap, ProtonReader, Status as ProtonStatus } from "../proton/index"
import type { CreateMailInput, ForwardCheck } from "../xrea/client"
import type { MailEntry } from "../xrea/errors"
import { ListCache } from "./listCache"
import { Mutex } from "./mutex"
import { randomName } from "./randomName"
import { MAIL_RE, normalizeName, validate, type CreateInput } from "./validate"
import { WORDS } from "./words"

export type Alias = { address: string; name: string; domain: string; forwardTo: string; protonEntries: string[] }
export type ErrorCode = "validation_error" | "forbidden" | "not_found" | "conflict" | "upstream_error" | "rate_limited"

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AppError"
  }
}

export type XreaPort = {
  mailList(): Promise<MailEntry[]>
  mailCreate(input: CreateMailInput): Promise<void>
  mailChangeForward(address: string, forwardTo: string, check: ForwardCheck): Promise<void>
  mailDelete(nos: number[]): Promise<void>
}

const FORWARD_ONLY = 1
const MAX_RANDOM_TRIES = 5
const addressOf = (m: { address_name: string; address_domain: string }) => `${m.address_name}@${m.address_domain}`.toLowerCase()

/** 応答に載せるのは5項目のみ。MailEntry を直接返さない */
function toAlias(m: Pick<MailEntry, "address_name" | "address_domain" | "address_trans">, entries: AddressMap): Alias {
  const address = addressOf(m)
  return { address, name: m.address_name, domain: m.address_domain, forwardTo: m.address_trans ?? "", protonEntries: [...(entries.get(address) ?? [])] }
}

export function deriveOptions(mails: readonly MailEntry[]): { domains: string[]; forwardTargets: string[] } {
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((s): s is string => !!s).map(s => s.toLowerCase()))].sort()
  return {
    domains: uniq(mails.map(m => m.address_domain)),
    forwardTargets: uniq(mails.map(m => m.address_trans)),
  }
}

export class AliasService {
  readonly listCache: ListCache
  private readonly mutex = new Mutex()

  constructor(
    private readonly deps: { xrea: XreaPort; proton: ProtonReader; words?: readonly string[]; rnd?: () => number; listTtlMs?: number; now?: () => number },
  ) {
    this.listCache = new ListCache(() => deps.xrea.mailList(), deps.listTtlMs, deps.now)
  }

  async listAliases(): Promise<{ aliases: Alias[]; proton: ProtonStatus }> {
    const mails = await this.listCache.get()
    const entries = this.deps.proton.getMap() // 待たずに現在の対応表を取る
    const aliases = mails
      .filter(m => m.pop_how === FORWARD_ONLY)
      .map(m => toAlias(m, entries))
      .sort((a, b) => a.address.localeCompare(b.address))
    return { aliases, proton: this.deps.proton.getStatus() }
  }

  async options(): Promise<{ domains: string[]; forwardTargets: string[] }> {
    return deriveOptions(await this.listCache.get())
  }

  createAlias(input: CreateInput): Promise<Alias> {
    return this.mutex.run(async () => {
      const mails = await this.listCache.fresh()
      const { domains } = deriveOptions(mails)
      const errors = validate(input, domains)
      if (errors.length) throw new AppError("validation_error", errors.join("。"))

      const domain = input.domain.trim().toLowerCase()
      const forwardTo = input.forwardTo.trim()
      const existing = new Set(mails.map(addressOf))
      let name = input.name === undefined ? "" : normalizeName(input.name)
      if (name === "") {
        for (let i = 0; i < MAX_RANDOM_TRIES && (name === "" || existing.has(`${name}@${domain}`)); i++)
          name = randomName(this.deps.words ?? WORDS, this.deps.rnd)
      }
      if (existing.has(`${name}@${domain}`)) throw new AppError("conflict", `${name}@${domain} はすでに存在します`)

      await this.deps.xrea.mailCreate({ name, domain, forwardTo })
      this.listCache.invalidate()
      return toAlias({ address_name: name, address_domain: domain, address_trans: forwardTo }, this.deps.proton.getMap())
    })
  }

  changeForward(address: string, forwardTo: string): Promise<Alias> {
    const to = forwardTo.trim()
    if (!MAIL_RE.test(to)) return Promise.reject(new AppError("validation_error", "転送先はメールアドレスの形式で指定してください"))
    return this.mutex.run(async () => {
      let target: MailEntry | undefined
      // 一覧の取り直し・アドレスの解決・送信はクライアントが続けて行う（番号のずれを防ぐ）
      await this.deps.xrea.mailChangeForward(address.trim(), to, m => {
        if (!m) throw new AppError("not_found", `${address} は存在しません`)
        if (m.pop_how !== FORWARD_ONLY) throw new AppError("forbidden", "転送のみのアドレス以外は変更できません")
        target = m
      })
      this.listCache.invalidate()
      return toAlias({ ...target!, address_trans: to }, this.deps.proton.getMap())
    })
  }

  deleteAlias(address: string): Promise<void> {
    return this.mutex.run(async () => {
      const mails = await this.listCache.fresh() // 取り直した一覧
      const target = mails.find(m => addressOf(m) === address.trim().toLowerCase())
      if (!target) throw new AppError("not_found", `${address} は存在しません`)
      if (target.pop_how !== FORWARD_ONLY) throw new AppError("forbidden", "転送のみのアドレス以外は削除できません")
      await this.deps.xrea.mailDelete([target.no]) // 直前の一覧の番号だけを使う
      this.listCache.invalidate()
    })
  }

  protonStatus(): ProtonStatus {
    return this.deps.proton.getStatus()
  }

  protonRefresh(): void {
    void this.deps.proton.refresh() // 完了を待たない
  }
}
