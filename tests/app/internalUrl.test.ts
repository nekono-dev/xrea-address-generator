import { describe, expect, test, vi } from "vitest"
import { ConfigError, loadAppConfig } from "../../src/app/config"
import { isInternalHost } from "../../src/app/internalUrl"
import { ENV } from "./helpers"

const gw = (u: string, httpPolicy: "all" | "external" = "external") => () => loadAppConfig({ ...ENV, PROTON_READER_URL: u }, { httpPolicy })

describe("内部URLの通信方式の検査", () => {
  test("internal-url-policy/AC-1: Workersの基準では http が失敗し、https が成功する", () => {
    expect(gw("http://proton-reader:8082", "all")).toThrow(ConfigError)
    expect(gw("http://192.168.1.5:8081", "all")).toThrow(ConfigError)
    expect(gw("https://gw.example.net", "all")()).toMatchObject({ readerUrl: "https://gw.example.net" })
  })

  test("internal-url-policy/AC-2: Node.jsの基準では公開ホスト名の https が成功する", () => {
    expect(gw("https://gw.example.net")().readerUrl).toBe("https://gw.example.net")
  })

  test("internal-url-policy/AC-3: 同梱サービス名とループバックへの http が成功する", () => {
    for (const u of ["http://proton-reader:8082", "http://localhost:8081", "http://127.0.0.1:8081", "http://[::1]:8081", "http://Proton-Reader:8082"]) {
      expect(gw(u)().readerUrl).toBe(u)
    }
    expect(gw("http://xrea-gateway:8081")).toThrow(ConfigError) // ゲートウェイは同梱サービスではなくなった
  })

  test("internal-url-policy/AC-4: クラスA〜Cのプライベートアドレスへの http が成功し、範囲の外側が失敗する", () => {
    for (const h of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"]) {
      expect(gw(`http://${h}:8081`)().readerUrl).toBe(`http://${h}:8081`)
    }
    for (const h of ["9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.1.1", "8.8.8.8"]) {
      expect(gw(`http://${h}:8081`)).toThrow(ConfigError)
    }
  })

  test("internal-url-policy/AC-5: 公開ホスト名と、プライベートに見えるだけのホストへの http が失敗する", () => {
    for (const u of ["http://gw.example.net", "http://xrea-gateway.example.net", "http://10.0.0.1.example.net", "http://192.168.1.1.nip.io", "http://notlocalhost"]) {
      expect(gw(u)).toThrow(ConfigError)
    }
    expect(isInternalHost("10.0.0.1.example.net")).toBe(false)
  })

  test("internal-url-policy/AC-6: 失敗のエラーに違反した環境変数の名前が含まれる", () => {
    expect(gw("http://gw.example.net")).toThrow("PROTON_READER_URL")
  })

  test("internal-url-policy/AC-7: 検査はfetchを呼ばずに結果を返す", () => {
    const f = vi.spyOn(globalThis, "fetch")
    isInternalHost("192.168.1.1")
    gw("https://gw.example.net")()
    expect(f).not.toHaveBeenCalled()
    f.mockRestore()
  })
})
