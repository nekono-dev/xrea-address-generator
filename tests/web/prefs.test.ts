// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from "vitest"
import { loadPrefs, PREFS_KEY, savePrefs } from "../../web/src/prefs"

afterEach(() => localStorage.clear())

/** 読み書きで例外を送出する保存先（容量超過・アクセス禁止を模す） */
const broken = (): Storage =>
  ({
    getItem: () => {
      throw new Error("denied")
    },
    setItem: () => {
      throw new Error("quota")
    },
  }) as unknown as Storage

describe("選択した値の保存と復元", () => {
  test("保存した値を既存の値へ併合して書き、読み戻せる", () => {
    savePrefs({ domain: "example.net" })
    savePrefs({ forwardTo: "me@mail.example", order: "desc" })
    savePrefs({ filter: null })
    expect(loadPrefs()).toEqual({ domain: "example.net", forwardTo: "me@mail.example", order: "desc", filter: null })
  })

  test("不正なJSON・型の違う値・不明な並び順は読み飛ばす", () => {
    localStorage.setItem(PREFS_KEY, "{")
    expect(loadPrefs()).toEqual({})
    localStorage.setItem(PREFS_KEY, JSON.stringify({ domain: 1, forwardTo: ["x"], filter: 3, order: "random" }))
    expect(loadPrefs()).toEqual({})
    localStorage.setItem(PREFS_KEY, "[]")
    expect(loadPrefs()).toEqual({})
  })

  test("保存先が使えないときは、例外を出さずに既定の動作を続ける", () => {
    expect(loadPrefs(broken())).toEqual({})
    expect(() => savePrefs({ domain: "x" }, broken())).not.toThrow()
  })
})
