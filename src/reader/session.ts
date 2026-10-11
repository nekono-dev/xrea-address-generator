// ログインと、セッション失効時の再ログイン。
import fs from "node:fs"
import { CliError, type CliRunner } from "./cli"

export class Session {
  constructor(
    private readonly run: CliRunner,
    private readonly sessionDir: string,
  ) {}

  /** セッションの保存先を作り、アクセストークン（環境変数）でログインする */
  async login(): Promise<void> {
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 })
    await this.run(["login"])
  }

  /** info が成功すれば何もしない。セッションが無ければ login を1回実行する */
  async ensure(): Promise<void> {
    try {
      await this.run(["info"])
    } catch (e) {
      if (!(e instanceof CliError) || !e.sessionExpired) throw e
      await this.login()
    }
  }

  /** セッション失効のときだけ再ログインし、処理を1回だけ再試行する */
  async withSession<T>(task: () => Promise<T>, onRelogin: () => void): Promise<T> {
    try {
      return await task()
    } catch (e) {
      if (!(e instanceof CliError) || !e.sessionExpired) throw e
      onRelogin()
      await this.login()
      return await task()
    }
  }
}
