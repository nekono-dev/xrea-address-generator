// 一覧の合成、中継、照合状態の組み立て。アプリ独自のデータは保存しない。
import type { Credentials, XreaCredentials } from "../credentials/types"
import { AppError } from "../shared/errors"
import type { CreateBody, GatewayAlias, GatewayClient, Options } from "./gatewayClient"
import type { EntriesResponse, ProtonStatus, ReaderClient } from "./readerClient"

export type Alias = GatewayAlias & { protonEntries: string[] }

const disabled: EntriesResponse = {
  status: { state: "disabled", updatedAt: null, reloginAt: null, itemCount: null, error: null },
  entries: {},
}
const unreachable: EntriesResponse = {
  status: { state: "error", updatedAt: null, reloginAt: null, itemCount: null, error: { kind: "cli", message: "Proton Pass読み取りサービスへ接続できません" } },
  entries: {},
}

export type ProtonCapability = "disabled" | "available" | "unavailable"

// 利用可否の結果の保持時間（ミリ秒）。外部への確認の頻度を抑える目的で、正しさには影響しない
export const CAPABILITY_TTL_MS = { available: 30_000, unavailable: 5_000 } as const

export class AppService {
  private capability: { value: "available" | "unavailable"; expiresAt: number } | null = null

  constructor(
    private gateway: GatewayClient,
    private reader: ReaderClient | null,
  ) {}

  /** XREAの一覧を1回取得できれば true。XREAが拒否したときは false、到達できないときは例外 */
  verify = async (x: XreaCredentials): Promise<boolean> => {
    try {
      await this.gateway.list(x)
      return true
    } catch (e) {
      if (e instanceof AppError && e.code === "upstream_error" && e.kind === "api") return false
      throw e
    }
  }

  /** 連携の利用可否。未設定なら通信しない。fresh のときは保持を無視して確認し、保持を更新する */
  protonCapability = async (opts: { fresh?: boolean } = {}): Promise<ProtonCapability> => {
    if (!this.reader) return "disabled"
    const now = Date.now()
    if (!opts.fresh && this.capability && now < this.capability.expiresAt) return this.capability.value
    let ok = false
    try {
      ok = await this.reader.health()
    } catch {
      ok = false
    }
    const value = ok ? "available" : "unavailable"
    this.capability = { value, expiresAt: Date.now() + CAPABILITY_TTL_MS[value] }
    return value
  }

  // 読み取りサービスが未設定、またはトークンが無ければ呼び出さない。失敗は照合の状態に写す
  private async readEntries(c: Credentials): Promise<EntriesResponse> {
    if (!this.reader || !c.protonToken) return disabled
    try {
      return await this.reader.entries(c.protonToken)
    } catch {
      return unreachable
    }
  }

  async listAliases(c: Credentials): Promise<{ aliases: Alias[]; proton: ProtonStatus }> {
    const [list, proton] = await Promise.all([this.gateway.list(c.xrea), this.readEntries(c)])
    return {
      aliases: list.map(a => ({ ...a, protonEntries: [...(proton.entries[a.address] ?? [])] })),
      proton: proton.status,
    }
  }

  options(c: Credentials): Promise<Options> {
    return this.gateway.options(c.xrea)
  }

  async createAlias(c: Credentials, b: CreateBody): Promise<Alias> {
    return this.withEntries(c, await this.gateway.create(c.xrea, b))
  }

  async changeForward(c: Credentials, address: string, forwardTo: string): Promise<Alias> {
    return this.withEntries(c, await this.gateway.changeForward(c.xrea, address, forwardTo))
  }

  async removeForward(c: Credentials, address: string): Promise<Alias> {
    return this.withEntries(c, await this.gateway.removeForward(c.xrea, address))
  }

  deleteAlias(c: Credentials, address: string): Promise<void> {
    return this.gateway.remove(c.xrea, address)
  }

  async protonStatus(c: Credentials): Promise<ProtonStatus> {
    return (await this.readEntries(c)).status
  }

  async protonRefresh(c: Credentials): Promise<void> {
    if (!this.reader || !c.protonToken) return
    await this.reader.refresh(c.protonToken).catch(() => undefined)
  }

  private async withEntries(c: Credentials, a: GatewayAlias): Promise<Alias> {
    const { entries } = await this.readEntries(c)
    return { ...a, protonEntries: [...(entries[a.address] ?? [])] }
  }
}
