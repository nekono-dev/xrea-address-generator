// XREAのメールAPIの型付きクライアント。認証項目の付与、送信、応答の正規化を行う。
import { normalizeList, toResult, XreaError, type MailEntry, type RawMailEntry } from "./errors"
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

  async mailList(body: MailListBody = {}): Promise<MailEntry[]> {
    return normalizeList(await this.post<Record<string, RawMailEntry>>("/v1/mail/list", body as FormObject))
  }

  async mailEdit(body: MailEditBody): Promise<void> {
    await this.post("/v1/mail/edit", body as unknown as FormObject)
  }

  async mailCreate(input: CreateMailInput): Promise<void> {
    await this.mailEdit({ reset_flg: 0, param: [createParam(input)] })
  }

  async mailDelete(nos: number[]): Promise<void> {
    const body: MailDeleteBody = { param: { no: nos } }
    await this.post("/v1/mail/delete", body as unknown as FormObject)
  }
}
