// 再ログイン・照合エラー・オフラインの帯。
export function Banner({ text, kind }: { text: string; kind: "relogin" | "error" | "offline" }) {
  return (
    <div class={`banner${kind === "relogin" ? "" : ` ${kind}`}`} data-kind={kind} role={kind === "error" ? "alert" : "status"}>
      {kind === "relogin" && <span class="sp" aria-hidden="true" />}
      <span>{text}</span>
    </div>
  )
}
