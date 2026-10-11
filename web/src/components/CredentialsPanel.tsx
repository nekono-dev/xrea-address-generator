// 認証情報の登録画面。ダイアログではなく、画面内のパネルとして表示する。
import { useEffect, useState } from "preact/hooks"
import { ApiFailure } from "../api"
import { canRegister, credentialsApi } from "../credentials"
import { Combobox } from "./Combobox"

const isImeEnter = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229
const INVALID_MESSAGE = "XREAの認証情報を確認できませんでした"

export function CredentialsPanel({
  notice,
  initialError,
  onRegistered,
  onCancel,
}: {
  notice?: string | null
  initialError?: string | null
  onRegistered: () => void
  onCancel?: () => void
}) {
  // 入力した値はこのコンポーネントの状態にだけ保持する（ブラウザの保存領域とURLには書かない）
  const [serverName, setServerName] = useState("")
  const [account, setAccount] = useState("")
  const [key, setKey] = useState("")
  const [token, setToken] = useState("")
  const [proton, setProton] = useState(false)
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

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await credentialsApi.register({
        xrea: { account: account.trim(), serverName: serverName.trim(), apiSecretKey: key },
        ...(token.trim() ? { protonToken: token.trim() } : {}),
      })
      onRegistered() // 登録画面を閉じ、一覧と候補を取得する
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
      <section class="cred" id="credentials" aria-labelledby="cred-title">
        <h2 id="cred-title">XREAの認証情報を登録</h2>
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
            登録
          </button>
        </form>
        {proton ? (
          <label class="cred-field">
            <span>Proton Pass アクセストークン（任意）</span>
            <input class="fld" name="proton-token" type="password" autoComplete="off" value={token} onInput={e => setToken((e.target as HTMLInputElement).value)} onKeyDown={enterToSubmit} />
          </label>
        ) : (
          <button type="button" class="ghost cred-proton" id="cred-proton" onClick={() => setProton(true)}>
            Proton Pass連携を使う
          </button>
        )}
        {error && (
          <p class="cred-error" role="alert">
            {error}
          </p>
        )}
        {onCancel && (
          <button type="button" class="ghost" id="cred-cancel" onClick={onCancel}>
            取り消し
          </button>
        )}
      </section>
    </main>
  )
}
