// 再ログイン・照合エラーの帯。
export function Banner({ text, kind }: { text: string; kind: "relogin" | "error" }) {
  return (
    <div class={`banner${kind === "error" ? " error" : ""}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "relogin" && <span class="sp" aria-hidden="true" />}
      <span>{text}</span>
    </div>
  )
}
