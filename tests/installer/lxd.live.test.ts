// 使い捨てのLXDコンテナ（ubuntu:24.04）での設定・導入・更新・アンインストールのテスト。LXD_LIVE=1 のときだけ実行する。
// 検証サーバ（LXDのホスト）で実行する。コンテナはテストの最後に破棄する。
import { execFileSync, execSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const live = process.env.LXD_LIVE === "1"
const root = path.resolve(__dirname, "../..")
const C = "xag-lxd-test"
const APP = "xrea-address-generator"
const CONF = `/etc/${APP}/${APP}.env`
const CTL = `/usr/local/bin/${APP}-ctl`
const REPO = "/root/xag-repo"
const LONG = 900_000

type Run = { code: number; out: string }
/** コンテナ内でコマンドを実行する。env はコンテナ内の環境変数として渡す */
function inC(cmd: string, env: Record<string, string> = {}): Run {
  const args = ["exec", C, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", "sh", "-c", cmd]
  const r = spawnSync("lxc", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}
const ok = (cmd: string, env: Record<string, string> = {}): string => {
  const r = inC(cmd, env)
  if (r.code !== 0) throw new Error(`失敗(${r.code}): ${cmd}\n${r.out.slice(-3000)}`)
  return r.out.trim()
}
const exists = (p: string) => inC(`test -e '${p}'`).code === 0
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const confValue = (k: string) => inC(`sed -n "s/^${k}='\\(.*\\)'$/\\1/p" ${CONF}`).out.trim()
async function waitHealthy(limitMs: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < limitMs) {
    if (inC("curl -fsS -m 2 http://127.0.0.1:3000/healthz").out.includes('"ok":true')) return Date.now() - start
    await sleep(250)
  }
  throw new Error("死活確認が成功しません")
}

/** 実アカウントの値が環境にあればそれを使い、無ければ形だけの値を使う */
const secrets = {
  XREA_SERVER_NAME: process.env.XREA_SERVER_NAME ?? "s1.example.test",
  XREA_API_SECRET_KEY: process.env.XREA_API_SECRET_KEY ?? "dummy",
  PROTON_PASS_PERSONAL_ACCESS_TOKEN: process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN ?? "dummy",
  PROTON_PASS_VAULT_NAME: process.env.PROTON_PASS_VAULT_NAME ?? "dummy",
}
const account = process.env.XREA_ACCOUNT ?? "dummy-account"
let commit = ""

function buildInstallSh(c: string, dest: string) {
  const out = execFileSync("sh", [path.join(root, "installer/build-bootstrap.sh"), "main", c, `file://${REPO}`], { encoding: "utf8" })
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inst-")), "install.sh")
  fs.writeFileSync(f, out)
  execFileSync("lxc", ["file", "push", f, `${C}${dest}`])
}
const installOnce = () => ok(`sh /root/install.sh install --set XREA_ACCOUNT=${account}`, { ...secrets, XREA_ACCOUNT: "from-env-must-lose" })

describe.runIf(live)("LXDコンテナでの導入", () => {
  beforeAll(async () => {
    // テスト対象のソースを、コミット1つのgitリポジトリにする
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "xag-lxd-"))
    const repo = path.join(work, "xag-repo")
    fs.mkdirSync(repo)
    execSync(
      `tar cf - --exclude=node_modules --exclude=.git --exclude=.env --exclude=dist --exclude=test-results --exclude=installer-dist . | tar xf - -C ${repo}`,
      { cwd: root, shell: "/bin/bash" },
    )
    const g = (a: string) => execSync(`git -C ${repo} -c user.name=test -c user.email=test@example.test ${a}`, { encoding: "utf8" }).trim()
    g("init -q -b main")
    g("add -A")
    g("commit -q -m test")
    commit = g("rev-parse HEAD")
    spawnSync("lxc", ["delete", "-f", C])
    execFileSync("lxc", ["launch", "ubuntu:24.04", C])
    for (let i = 0; i < 60 && inC("getent hosts deb.nodesource.com").code !== 0; i++) await sleep(1000)
    execFileSync("lxc", ["file", "push", "-r", repo, `${C}/root/`])
    // 送ったファイルはホスト側の所有者のままになり、コンテナ内の root の git が読み込みを拒否するため、所有者を直す
    ok(`chown -R root:root ${REPO}`)
    buildInstallSh(commit, "/root/install.sh")
    fs.rmSync(work, { recursive: true, force: true })
  }, LONG)

  afterAll(() => {
    if (!process.env.KEEP_CONTAINER) spawnSync("lxc", ["delete", "-f", C])
  })

  describe("config", () => {
    test("lxc-installer/AC-6: 必須の設定が欠けた導入が、設定ファイルもサービスも作らずに、不足しているキー名を表示して失敗する", () => {
      const r = inC("sh /root/install.sh install")
      expect(r.code).not.toBe(0)
      expect(r.out).toContain("必須の設定がありません")
      for (const k of ["XREA_ACCOUNT", "XREA_SERVER_NAME", "XREA_API_SECRET_KEY", "PROTON_PASS_PERSONAL_ACCESS_TOKEN", "PROTON_PASS_VAULT_NAME"]) expect(r.out).toContain(k)
      expect(exists(`/etc/${APP}`)).toBe(false)
      expect(exists(`/etc/systemd/system/${APP}.service`)).toBe(false)
    }, LONG)

    test("lxc-installer/AC-7: 宣言のないキーの指定と、アポストロフィまたは改行を含む値が、拒否される", () => {
      const unknown = inC(`sh /root/install.sh install --set NO_SUCH_KEY=1 --set XREA_ACCOUNT=${account}`, secrets)
      expect(unknown.code).not.toBe(0)
      expect(unknown.out).toContain("NO_SUCH_KEY")
      const quote = inC(`sh /root/install.sh install --set "XREA_ACCOUNT=a'b"`, secrets)
      expect(quote.code).not.toBe(0)
      expect(quote.out).toContain("' は使えません")
      const newline = inC(`sh /root/install.sh install --set "XREA_ACCOUNT=$(printf 'a\\nb')"`, secrets)
      expect(newline.code).not.toBe(0)
      expect(exists(`/etc/${APP}`)).toBe(false)
    }, LONG)
  })

  describe("install", () => {
    let firstMs = 0
    beforeAll(() => {
      const t0 = Date.now()
      installOnce()
      firstMs = Date.now() - t0
    }, LONG)

    test("lxc-installer/AC-15: 新規のUbuntuコンテナでの初回の導入が、10分以内に完了する", () => {
      console.log(`初回の導入: ${Math.round(firstMs / 1000)}秒`)
      expect(firstMs).toBeLessThanOrEqual(600_000)
    })

    test("lxc-installer/AC-1: 埋め込んだコミットのソースが取得先に展開され、コミットが一致しない取得物では本体が実行されずに中止される", () => {
      expect(ok(`git -C /opt/${APP} rev-parse HEAD`)).toBe(commit)
      // 存在しないコミットを埋め込んだ install.sh は、取得の段階で中止し、本体を実行しない
      buildInstallSh("f".repeat(40), "/root/install-bad.sh")
      const before = ok(`cat ${CONF} | sha256sum`)
      const r = inC("XREA_ADDRESS_GENERATOR_DIR=/opt/xag-bad sh /root/install-bad.sh install", secrets)
      expect(r.code).not.toBe(0)
      expect(exists("/opt/xag-bad/installer/main.sh")).toBe(false)
      expect(ok(`cat ${CONF} | sha256sum`)).toBe(before)
    }, LONG)

    test("lxc-installer/AC-2: 必須の設定を指定して導入した後、アプリのサービスが稼働し、cloudflaredはトークンを指定したときだけ稼働する", async () => {
      expect(ok(`systemctl is-active ${APP}`)).toBe("active")
      await waitHealthy(30_000)
      expect(exists("/etc/systemd/system/cloudflared-xrea.service")).toBe(false)
      // トークンを指定すると cloudflared を導入してサービスを登録し、空にすると取り除く
      ok("sh /root/install.sh install --set TUNNEL_TOKEN=dummy-token-for-test")
      expect(ok("command -v cloudflared")).toContain("cloudflared")
      expect(ok("systemctl is-enabled cloudflared-xrea")).toBe("enabled")
      ok("sh /root/install.sh install --set TUNNEL_TOKEN=")
      expect(exists("/etc/systemd/system/cloudflared-xrea.service")).toBe(false)
      expect(ok(`systemctl is-active ${APP}`)).toBe("active")
    }, LONG)

    test("lxc-installer/AC-4: 設定ファイルの権限が600になり、指定オプション、環境変数、既存の設定ファイル、既定値の優先順位で値が決まる", () => {
      expect(ok(`stat -c %a ${CONF}`)).toBe("600")
      expect(confValue("XREA_ACCOUNT")).toBe(account) // 指定オプション > 環境変数
      expect(confValue("PORT")).toBe("3000") // 既定値
      ok(`sed -i "s/^LOG_LEVEL=.*/LOG_LEVEL='debug'/" ${CONF}`)
      ok("sh /root/install.sh install")
      expect(confValue("LOG_LEVEL")).toBe("debug") // 既存の設定ファイル > 既定値
      ok("sh /root/install.sh install", { LOG_LEVEL: "warn" })
      expect(confValue("LOG_LEVEL")).toBe("warn") // 環境変数 > 既存の設定ファイル
      ok("sh /root/install.sh install --set LOG_LEVEL=info", { LOG_LEVEL: "error" })
      expect(confValue("LOG_LEVEL")).toBe("info") // 指定オプション > 環境変数
    }, LONG)

    test("lxc-installer/AC-3: 導入を2回続けて実行しても2回目が成功し、サービスの稼働状態と設定ファイルの内容が変わらない", () => {
      const before = ok(`sha256sum ${CONF}`)
      ok("sh /root/install.sh install")
      expect(ok(`sha256sum ${CONF}`)).toBe(before)
      expect(ok(`systemctl is-active ${APP}`)).toBe("active")
    }, LONG)

    test("lxc-installer/AC-5: 設定ファイルを手で編集して導入を再実行しても、編集した値が保持され、増えたキーだけが追記される", () => {
      ok(`sed -i "s/^PORT=.*/PORT='3000'/; s/^BIND_ADDRESS=.*/BIND_ADDRESS='127.0.0.1'/" ${CONF}`)
      ok(`sed -i '/^SESSION_DIR=/d' ${CONF}`) // キーを1つ消し、再実行で既定値として追記されることを確かめる
      ok(`echo "# 手で書いたメモ" >> ${CONF}`)
      ok("sh /root/install.sh install")
      expect(ok(`cat ${CONF}`)).toContain("# 手で書いたメモ")
      expect(confValue("SESSION_DIR")).toBe(`/var/lib/${APP}/session`)
      expect(confValue("XREA_ACCOUNT")).toBe(account)
    }, LONG)

    test("lxc-installer/AC-12: アプリのポートが、コンテナの内側のループバックでだけ応答する", () => {
      const listen = ok("ss -ltnH")
      expect(listen).toMatch(/127\.0\.0\.1:3000\s/)
      expect(listen).not.toMatch(/(0\.0\.0\.0|\*|\[::\]):3000\s/)
    })

    test("lxc-installer/AC-17: コンテナの外部アドレスからアプリのポートへ接続できない", () => {
      const ip = ok("hostname -I").split(/\s+/)[0]!
      const r = spawnSync("curl", ["-s", "-m", "3", `http://${ip}:3000/healthz`], { encoding: "utf8" })
      expect(r.status).not.toBe(0)
    })

    test("lxc-installer/AC-16: サービスの起動から死活確認が成功するまでが、30秒以内である", async () => {
      ok(`systemctl restart ${APP}`)
      const ms = await waitHealthy(30_000)
      console.log(`起動から死活確認の成功まで: ${ms}ms`)
      expect(ms).toBeLessThanOrEqual(30_000)
    })

    test("lxc-installer/AC-13: アプリのプロセスを強制終了すると、自動で再起動して死活確認が成功する", async () => {
      const pid = ok(`systemctl show -p MainPID --value ${APP}`)
      ok(`kill -9 ${pid}`)
      await sleep(3000)
      await waitHealthy(30_000)
      expect(ok(`systemctl show -p MainPID --value ${APP}`)).not.toBe(pid)
    }, 60_000)
  })

  describe("lifecycle", () => {
    beforeAll(() => {
      if (!exists(CTL)) installOnce()
    }, LONG)

    test("lxc-installer/AC-9: 状態表示が、導入先・参照名・コミット・取得元・更新日時を表示する", () => {
      const s = ok(`${CTL} status`)
      expect(s).toContain(`導入先:     /opt/${APP}`)
      expect(s).toContain("REF:        main")
      expect(s).toContain(`コミット:   ${commit}`)
      expect(s).toContain(`取得元:     file://${REPO}`)
      expect(s).toMatch(/更新日時:\s+\d{4}-\d{2}-\d{2}T/)
    })

    test("lxc-installer/AC-8: 新しいコミットの配布後、常設コマンドの更新で新しいコミットに追従し、増えた設定キーが追記され、サービスが再起動される", () => {
      // 取得元に、設定キーを1つ増やした新しいコミットを作る
      ok(`echo 'XAG_TEST_NEW_KEY|hello|optional|テスト用に追加したキー' >> ${REPO}/installer/config.schema && git -C ${REPO} -c user.name=t -c user.email=t@example.test commit -qam 'add key'`)
      const next = ok(`git -C ${REPO} rev-parse HEAD`)
      const startedBefore = ok(`systemctl show -p ActiveEnterTimestampMonotonic --value ${APP}`)
      const t0 = Date.now()
      ok(`${CTL} update`)
      const ms = Date.now() - t0
      console.log(`常設コマンドによる更新: ${Math.round(ms / 1000)}秒`)
      expect(ok(`git -C /opt/${APP} rev-parse HEAD`)).toBe(next)
      expect(ok(`${CTL} status`)).toContain(`コミット:   ${next}`)
      expect(confValue("XAG_TEST_NEW_KEY")).toBe("hello")
      expect(ok(`systemctl show -p ActiveEnterTimestampMonotonic --value ${APP}`)).not.toBe(startedBefore)
      expect(ok(`systemctl is-active ${APP}`)).toBe("active")
      // 古い install.sh の update は、その install.sh のコミットへ揃える
      ok("sh /root/install.sh update")
      expect(ok(`git -C /opt/${APP} rev-parse HEAD`)).toBe(commit)
    }, LONG)

    test("lxc-installer/AC-18: 常設コマンドによる更新が、5分以内に完了する", () => {
      const t0 = Date.now()
      ok(`${CTL} update`)
      expect(Date.now() - t0).toBeLessThanOrEqual(300_000)
    }, LONG)

    test("lxc-installer/AC-10: アンインストールの後、アプリ本体・常設コマンド・取得先が存在せず、設定とデータが残り、再導入で設定が再利用される", () => {
      ok(`${CTL} uninstall`)
      expect(exists(`/opt/${APP}`)).toBe(false)
      expect(exists(CTL)).toBe(false)
      expect(exists(`/etc/systemd/system/${APP}.service`)).toBe(false)
      expect(exists(CONF)).toBe(true)
      expect(exists(`/var/lib/${APP}`)).toBe(true)
      // 設定が残っているので、指定なしの再導入が成功する
      ok("sh /root/install.sh install")
      expect(ok(`systemctl is-active ${APP}`)).toBe("active")
      expect(confValue("XREA_ACCOUNT")).toBe(account)
    }, LONG)

    test("lxc-installer/AC-11: 完全削除を指定したアンインストールの後、設定・データ・導入メタ情報・専用ユーザーも存在しない", () => {
      ok(`${CTL} uninstall --purge`)
      for (const p of [`/etc/${APP}`, `/var/lib/${APP}`, `/var/lib/${APP}-installer`, `/opt/${APP}`, CTL]) expect(exists(p)).toBe(false)
      expect(inC("id xrea-gen").code).not.toBe(0)
      // Node.js と Proton Pass CLI は残す
      expect(inC("command -v node && command -v pass-cli").code).toBe(0)
    }, LONG)
  })
})
