import { describe, expect, test } from "vitest"
import { deriveKey, open, seal } from "../../src/credentials/seal"
import { createCookieStore } from "../../src/credentials/cookieStore"
import { LIMITS, type Credentials } from "../../src/credentials/types"

const SECRET = "a".repeat(32)
const cred: Credentials = {
  xrea: { account: "acct", serverName: "s1.xrea.com", apiSecretKey: "SECRET-KEY-VALUE" },
  protonToken: "pat-token-value",
}

describe("seal", () => {
  test("credential-session/AC-3: 暗号文から平文が読み取れず、同じ鍵で復号すると元に戻る", async () => {
    const key = await deriveKey(SECRET)
    const sealed = await seal(key, cred)
    expect(sealed.startsWith("v1.")).toBe(true)
    expect(sealed).not.toContain("SECRET-KEY-VALUE")
    expect(atob(sealed.slice(sealed.indexOf(".", 3) + 1).replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("SECRET-KEY-VALUE")
    expect(await open(key, sealed)).toEqual(cred)
  })

  test("credential-session/AC-6: 1文字改ざんした暗号文と別の鍵の暗号文は null になる", async () => {
    const key = await deriveKey(SECRET)
    const sealed = await seal(key, cred)
    const i = sealed.length - 5
    const tampered = sealed.slice(0, i) + (sealed[i] === "A" ? "B" : "A") + sealed.slice(i + 1)
    expect(await open(key, tampered)).toBeNull()
    expect(await open(await deriveKey("b".repeat(32)), sealed)).toBeNull()
    expect(await open(key, "v1.!!!")).toBeNull()
    expect(await open(key, "garbage")).toBeNull()
  })

  test("credential-session/AC-13: 暗号化と復号がそれぞれ5ミリ秒以内", async () => {
    const key = await deriveKey(SECRET)
    await open(key, await seal(key, cred)) // 初回のJIT分を除く
    const t0 = performance.now()
    const sealed = await seal(key, cred)
    const t1 = performance.now()
    await open(key, sealed)
    const t2 = performance.now()
    expect(t1 - t0).toBeLessThanOrEqual(5)
    expect(t2 - t1).toBeLessThanOrEqual(5)
  })

  test("credential-session/AC-14: 上限長いっぱいの認証情報のcookieの値が4096バイト以下", async () => {
    const key = await deriveKey(SECRET)
    const full: Credentials = {
      xrea: {
        account: "a".repeat(LIMITS.account),
        serverName: "s".repeat(LIMITS.serverName),
        apiSecretKey: "k".repeat(LIMITS.apiSecretKey),
      },
      protonToken: "t".repeat(LIMITS.protonToken),
    }
    const header = await createCookieStore(key, { secure: true }).save(full)
    const value = header.split(";")[0]!.split("=")[1]!
    expect(value.length).toBeLessThanOrEqual(4096)
  })
})
