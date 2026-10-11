// ヘッダのログアウトボタン。確認は挟まず、押すと登録を解除して登録画面へ戻る。
export function CredentialsButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="cred-btn" id="cred-logout" onClick={onClick}>
      ログアウト
    </button>
  )
}
