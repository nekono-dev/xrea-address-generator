// XREAのメールAPIの型付きクライアント。認証項目の付与、送信、応答の正規化を行う。
import { omitSecret, sortedEntries, toResult, XreaError, type MailEntry, type RawMailEntry } from "./errors"
import { toFormBody, type FormObject } from "./form"
import type { paths } from "./generated/schema"
import { EndpointQueue } from "./queue"

export const TIMEOUT_MS = 15000
export const BASE_URL = "https://api.xrea.com"

type FormBody<P extends keyof paths> = paths[P] extends { post: { requestBody: { content: { "application/x-www-form-urlencoded": infer B } } } }
  ? B
  : never
type Auth = "account" | "server_name" | "api_secret_key"
export type MailEditBody = Omit<FormBody<"/v1/mail/edit">, Auth>
export type MailEditParam = MailEditBody["param"][number]
export type MailDeleteBody = Omit<FormBody<"/v1/mail/delete">, Auth>
export type MailListBody = Omit<FormBody<"/v1/mail/list">, Auth>

export type XreaConfig = { account: string; serverName: string; apiSecretKey: string }
export type CreateMailInput = { name: string; domain: string; forwardTo: string }
type FetchLike = (url: string, init: { method: string; body: URLSearchParams; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>

const ENV_KEYS = { account: "XREA_ACCOUNT", serverName: "XREA_SERVER_NAME", apiSecretKey: "XREA_API_SECRET_KEY" } as const

/** 環境変数から認証情報を読む。不足があれば変数名を示して例外を送出する */
export function loadXreaConfig(env: NodeJS.ProcessEnv = process.env): XreaConfig {
  const missing = Object.values(ENV_KEYS).filter(k => !env[k])
  if (missing.length) throw new Error(`必須の環境変数が未設定: ${missing.join(", ")}`)
  return { account: env[ENV_KEYS.account]!, serverName: env[ENV_KEYS.serverName]!, apiSecretKey: env[ENV_KEYS.apiSecretKey]! }
}

/** 転送のみのアドレスを作成するときの送信内容（容量0、各フィルタ0、パスワードはランダム生成） */
export function createParam(input: CreateMailInput): MailEditParam {
  return {
    address_name: input.name,
    address_domain: input.domain,
    address: `${input.name}@${input.domain}`,
    pop_how: 1,
    address_trans: input.forwardTo,
    pop_pass_rand: 1,
    quota: 0,
    autorespond: 0,
    clamd: 0,
    spamd: 0,
    customd: 0,
  }
}

// 一覧専用の項目。編集の要求には含めない
export const LIST_ONLY = ["mail_num", "quota_use_byte", "quota_use_per"] as const

/** 一覧の項目（番号・パスワード・フィルタ・自動返信を含む）をそのまま使い、転送先だけを差し替える */
export function changeForwardParam(raw: RawMailEntry, forwardTo: string): MailEditParam {
  const param = Object.fromEntries(Object.entries(raw).filter(([k]) => !(LIST_ONLY as readonly string[]).includes(k)))
  return { ...param, address_trans: forwardTo } as MailEditParam
}

/** 受信方法（1 転送のみ、2 受信のみ、3 両方）と転送先を差し替える。転送の追加は 2→3、解除は 3→2 */
export function setForwardParam(raw: RawMailEntry, forwardTo: string, popHow: 1 | 2 | 3): MailEditParam {
  return { ...changeForwardParam(raw, forwardTo), pop_how: popHow } as MailEditParam
}

/** 転送先の変更の前に、解決したアドレスを検査する。変更させないときは例外を送出する */
export type ForwardCheck = (entry: MailEntry | undefined) => asserts entry is MailEntry

export class XreaClient {
  private readonly queue: EndpointQueue

  constructor(
    private readonly config: XreaConfig,
    private readonly opts: { fetch?: FetchLike; queue?: EndpointQueue; baseUrl?: string; timeoutMs?: number } = {},
  ) {
    this.queue = opts.queue ?? new EndpointQueue()
  }

  private async post<T>(path: keyof paths, body: FormObject): Promise<T | undefined> {
    const form = toFormBody({
      account: this.config.account,
      server_name: this.config.serverName,
      api_secret_key: this.config.apiSecretKey,
      ...body,
    })
    const doFetch = this.opts.fetch ?? (fetch as unknown as FetchLike)
    const timeoutMs = this.opts.timeoutMs ?? TIMEOUT_MS
    return this.queue.run(path, async () => {
      let res
      try {
        res = await doFetch(`${this.opts.baseUrl ?? BASE_URL}${path}`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        const err = e as Error
        if (err.name === "TimeoutError" || err.name === "AbortError")
          throw new XreaError(0, `XREAの応答が${timeoutMs / 1000}秒以内に返りませんでした`, "timeout")
        throw new XreaError(0, `XREAへ接続できませんでした: ${err.message}`, "network")
      }
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new XreaError(res.status, `XREAの応答を解釈できませんでした（HTTP ${res.status}）`, "api")
      }
      return toResult<T>(json)
    })
  }

  // パスワード項目を含む一覧。クラスの外へは出さない
  private async rawList(body: MailListBody = {}): Promise<RawMailEntry[]> {
    return sortedEntries(await this.post<Record<string, RawMailEntry>>("/v1/mail/list", body as FormObject))
  }

  async mailList(body: MailListBody = {}): Promise<MailEntry[]> {
    return (await this.rawList(body)).map(omitSecret)
  }

  async mailEdit(body: MailEditBody): Promise<void> {
    await this.post("/v1/mail/edit", body as unknown as FormObject)
  }

  async mailCreate(input: CreateMailInput): Promise<void> {
    await this.mailEdit({ reset_flg: 0, param: [createParam(input)] })
  }

  /** 一覧を取り直してアドレスを解決し、check の検査を通ったものだけを、plan が返す受信方法と転送先で再送信する */
  private async editForward(address: string, check: ForwardCheck, plan: (e: RawMailEntry) => { forwardTo: string; popHow: 1 | 2 | 3 }): Promise<void> {
    const key = address.toLowerCase()
    const raw = (await this.rawList()).find(m => `${m.address_name}@${m.address_domain}`.toLowerCase() === key)
    check(raw && omitSecret(raw))
    // 一覧の取得の直後に送る（削除や変更の後に、ほかのアドレスの番号が変わり得るため）
    const p = plan(raw!)
    await this.mailEdit({ reset_flg: 0, param: [setForwardParam(raw!, p.forwardTo, p.popHow)] })
  }

  /** 転送先を設定する。受信のみ（2）のアドレスでは転送を追加して受信方法を両方（3）にし、ほかは受信方法を保つ */
  async mailChangeForward(address: string, forwardTo: string, check: ForwardCheck): Promise<void> {
    await this.editForward(address, check, e => ({ forwardTo, popHow: e.pop_how === 2 ? 3 : (e.pop_how as 1 | 3) }))
  }

  /** 転送を解除する。受信方法を受信のみ（2）にし、転送先を空にする */
  async mailRemoveForward(address: string, check: ForwardCheck): Promise<void> {
    await this.editForward(address, check, () => ({ forwardTo: "", popHow: 2 }))
  }

  async mailDelete(nos: number[]): Promise<void> {
    const body: MailDeleteBody = { param: { no: nos } }
    await this.post("/v1/mail/delete", body as unknown as FormObject)
  }
}
