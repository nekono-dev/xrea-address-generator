// Vault一覧の取得を差し込む、公式CLIの疑似実装の補助。
import type { CliRunner } from "../../src/proton/cli"

/** Vault一覧の出力（共有IDは s0, s1, ...） */
export const vaultsJson = (n = 1) =>
  JSON.stringify({ vaults: Array.from({ length: n }, (_, i) => ({ name: `vault${i}`, vault_id: `id${i}`, share_id: `s${i}` })) })

/** `vault list` にはn個のVaultを返し、それ以外は元の疑似実装に任せる */
export const withVaults =
  (run: CliRunner, n = 1): CliRunner =>
  async args =>
    args[0] === "vault" ? { stdout: vaultsJson(n), durationMs: 1 } : run(args)
