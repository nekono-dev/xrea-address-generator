// ヘッダの認証情報ボタン。登録画面を開く。
export function CredentialsButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="cred-btn" id="cred-open" onClick={onClick}>
      認証情報
    </button>
  )
}
