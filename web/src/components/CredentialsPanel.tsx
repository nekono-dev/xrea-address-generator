// XREAへのログイン画面（認証情報の登録）。ダイアログではなく、画面内のパネルとして表示する。
import { useEffect, useState } from "preact/hooks"
import { ApiFailure } from "../api"
import { canRegister, credentialsApi, type ProtonCapability } from "../credentials"
import { loadServerName, saveServerName } from "../prefs"
import { Combobox } from "./Combobox"

const isImeEnter = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229
const INVALID_MESSAGE = "XREAの認証情報を確認できませんでした"

export function CredentialsPanel({
  notice,
  initialError,
  onRegistered,
}: {
  notice?: string | null
  initialError?: string | null
  onRegistered: (r?: { proton?: ProtonCapability }) => void
}) {
  // 入力した値はこのコンポーネントの状態にだけ保持する（ブラウザの保存領域とURLには書かない）
  // ただしサーバ名は秘匿情報ではないため、localStorageへ保存して次回の初期値にする
  const [serverName, setServerName] = useState(() => loadServerName())
  const [account, setAccount] = useState("")
  const [key, setKey] = useState("")
  const [token, setToken] = useState("")
  const [proton, setProton] = useState(false)
  const [capability, setCapability] = useState<ProtonCapability>("disabled")
  const [servers, setServers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const canSubmit = canRegister(account, serverName, key, servers) && !busy
  const badServer = servers.length > 0 && serverName.trim() !== "" && !servers.includes(serverName.trim())

  // サーバ名の選択肢は表示時に1回取得する。失敗したときは自由入力にする
  useEffect(() => {
    credentialsApi
      .servers()
      .then(r => setServers(r.servers))
      .catch(() => undefined)
  }, [])

  // 連携の利用可否は表示時に1回取得する。失敗したときは連携なし（disabled）として扱う
  useEffect(() => {
    credentialsApi
      .capabilities()
      .then(r => setCapability(r.proton))
      .catch(() => undefined)
  }, [])

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const res = await credentialsApi.register({
        xrea: { account: account.trim(), serverName: serverName.trim(), apiSecretKey: key },
        ...(token.trim() ? { protonToken: token.trim() } : {}),
      })
      saveServerName(serverName.trim())
      onRegistered(res) // 登録画面を閉じ、一覧と候補を取得する。トークンを保持しなかったときは応答を渡す
    } catch (e) {
      const f = e as ApiFailure
      setError(f.code === "invalid_credentials" ? INVALID_MESSAGE : f.message) // 入力値は消さない
    } finally {
      setBusy(false)
    }
  }
  const enterToSubmit = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !isImeEnter(e)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <main class="wrap">
      <h1 class="cred-app">XREA ALIAS DASHBOARD</h1>
      <section class="cred cred-head" id="credentials" aria-labelledby="cred-title">
        <h2 id="cred-title">XREAへログイン</h2>
        {notice && (
          <p class="cred-notice" role="status">
            {notice}
          </p>
        )}
        <div class="cred-field">
          <span>サーバ名</span>
          <Combobox
            id="cred-server"
            name="server"
            type="search"
            label="サーバ名"
            placeholder="検索して選択"
            noneText="該当するサーバがありません"
            candidates={servers}
            value={serverName}
            invalid={badServer}
            onInput={setServerName}
            onEnter={() => void submit()}
          />
        </div>
      </section>
      {/* サーバ名欄（autocomplete=off）とログインフォームを同じ区画に置くと、Proton Passがアカウントだけを補完しシークレットキーを補完しない。区画を分ける */}
      <section class="cred cred-rest" aria-label="アカウントとシークレットキー">
        <form
          class="cred-form"
          onSubmit={e => {
            e.preventDefault()
            void submit()
          }}
        >
          <label class="cred-field">
            <span>アカウント</span>
            <input class="fld" name="username" autoComplete="username" value={account} onInput={e => setAccount((e.target as HTMLInputElement).value)} />
          </label>
          <label class="cred-field">
            <span>シークレットキー</span>
            <input class="fld" name="password" type="password" autoComplete="current-password" value={key} onInput={e => setKey((e.target as HTMLInputElement).value)} />
          </label>
          <button type="submit" class="btn" id="cred-submit" disabled={!canSubmit}>
            ログイン
          </button>
        </form>
        {proton ? (
          <label class="cred-field">
            <span>Proton Pass アクセストークン（任意）</span>
            {/* type="password"だとProton Passが新規パスワード作成フォームとみなすため、type="search"にして文字は伏せ字にする */}
            <input class="fld secret" name="proton-token" type="search" autoComplete="off" spellcheck={false} value={token} onInput={e => setToken((e.target as HTMLInputElement).value)} onKeyDown={enterToSubmit} />
          </label>
        ) : capability === "available" ? (
          <button type="button" class="ghost cred-proton" id="cred-proton" onClick={() => setProton(true)}>
            Proton Pass連携を使う
          </button>
        ) : capability === "unavailable" ? (
          <p class="cred-hint">Proton Pass連携は現在利用できません</p>
        ) : null}
        {error && (
          <p class="cred-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}
