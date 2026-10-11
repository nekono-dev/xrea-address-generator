// 対応表のキャッシュ、再取得の合流、状態の管理。
import { consoleLogger, type Logger } from "../shared/logger"
import { CliError, FIXED_MESSAGES, ForbiddenCommandError, type CliRunner, type ErrorKind } from "./cli"
import { mergeProjections, project, vaultShareIds, type AddressMap } from "./projection"
import type { Session } from "./session"

export type ReaderState = "loading" | "ready" | "relogin" | "error"
export type Status = {
  state: ReaderState
  updatedAt: string | null
  reloginAt: string | null
  itemCount: number | null
  error: { kind: ErrorKind; message: string } | null
}

export const TTL_MS = 600_000

export class CachedReader {
  private map: AddressMap = new Map()
  private fetchedAt: number | null = null
  private inflight: Promise<void> | null = null
  private status: Status = { state: "loading", updatedAt: null, reloginAt: null, itemCount: null, error: null }

  constructor(
    private readonly opts: {
      run: CliRunner
      session: Session
      ttlMs?: number
      now?: () => number
      logger?: Logger
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  getMap(): AddressMap {
    const ttl = this.opts.ttlMs ?? TTL_MS
    // 取得に失敗した後（state が error）は、自動では再取得しない
    if (this.status.state === "ready" && this.fetchedAt !== null && this.now() - this.fetchedAt >= ttl && !this.inflight) void this.refresh()
    return this.map
  }

  getStatus(): Status {
    return { ...this.status }
  }

  refresh(): Promise<void> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<void> {
    const log = this.opts.logger ?? consoleLogger
    this.status = { ...this.status, state: "loading", error: null }
    try {
      let relogged = false
      // 取得結果の文字列は変数に保持せず、変換関数の戻り値だけを受け取る
      const { result, durationMs } = await this.opts.session.withSession(
        async () => {
          // トークンで参照できるVaultをすべて探索し、Vaultごとに取得して1つにまとめる
          const vaults = await this.opts.run(["vault", "list", "--output", "json"])
          const shareIds = vaultShareIds(vaults.stdout)
          let ms = vaults.durationMs
          const parts = []
          for (const id of shareIds) {
            const r = await this.opts.run(["item", "list", "--share-id", id, "--filter-state", "active", "--output", "json", "--show-secrets"])
            parts.push(project(r.stdout))
            ms += r.durationMs
          }
          return { result: { ...mergeProjections(parts), vaultCount: shareIds.length }, durationMs: ms }
        },
        () => {
          relogged = true
          this.status = { ...this.status, state: "relogin" }
          log.warn({ cmd: "login", reason: "session_expired" })
        },
      )
      this.map = result.map
      this.fetchedAt = this.now()
      const at = new Date(this.now()).toISOString()
      this.status = {
        state: "ready",
        updatedAt: at,
        reloginAt: relogged ? at : this.status.reloginAt,
        itemCount: result.itemCount,
        error: null,
      }
      log.info({ cmd: "item list", exitCode: 0, durationMs, itemCount: result.itemCount, vaultCount: result.vaultCount })
    } catch (e) {
      const kind: ErrorKind = e instanceof CliError ? e.kind : e instanceof ForbiddenCommandError ? "cli" : "unknown"
      const message = e instanceof CliError ? e.message : FIXED_MESSAGES[kind]
      // 直前の対応表を保持し、状態を error にする
      this.status = { ...this.status, state: "error", error: { kind, message } }
      log.warn({ cmd: "item list", exitCode: 1, kind })
    }
  }
}
