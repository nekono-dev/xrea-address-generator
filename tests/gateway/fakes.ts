// テスト用の偽のXREA。
import type { CreateMailInput, ForwardCheck } from "../../src/xrea/client"
import type { MailEntry } from "../../src/xrea/errors"
import type { XreaPort } from "../../src/gateway/service"

export const mail = (no: number, name: string, domain: string, popHow: 1 | 2 | 3 | 4, trans = "me@mail.example"): MailEntry =>
  ({ no, address_name: name, address_domain: domain, address: `${name}@${domain}`, pop_how: popHow, address_trans: popHow === 2 ? "" : trans, quota: "0" }) as MailEntry

export class FakeXrea implements XreaPort {
  calls: string[] = []
  created: CreateMailInput[] = []
  deleted: number[][] = []
  changed: { no: number; forwardTo: string }[] = []
  delayMs = 0
  log: { op: string; start: number; end: number }[] = []

  constructor(public mails: MailEntry[]) {}

  private async step<T>(op: string, f: () => T): Promise<T> {
    const start = performance.now()
    this.calls.push(op)
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs))
    const r = f()
    this.log.push({ op, start, end: performance.now() })
    return r
  }

  mailList(): Promise<MailEntry[]> {
    return this.step("list", () => this.mails.map(m => ({ ...m })))
  }

  mailCreate(input: CreateMailInput): Promise<void> {
    return this.step("create", () => {
      this.created.push(input)
      const no = Math.max(0, ...this.mails.map(m => m.no)) + 1
      this.mails.push(mail(no, input.name, input.domain, 1, input.forwardTo))
    })
  }

  // 実物と同じく、一覧の取り直しと編集の2回の呼び出しで構成する
  async mailChangeForward(address: string, forwardTo: string, check: ForwardCheck): Promise<void> {
    const mails = await this.mailList()
    const m = mails.find(x => `${x.address_name}@${x.address_domain}`.toLowerCase() === address.toLowerCase())
    check(m)
    await this.step("change", () => {
      this.changed.push({ no: m.no, forwardTo })
      this.mails = this.mails.map(x => (x.no === m.no ? { ...x, address_trans: forwardTo } : x))
    })
  }

  mailDelete(nos: number[]): Promise<void> {
    return this.step("delete", () => {
      this.deleted.push(nos)
      this.mails = this.mails.filter(m => !nos.includes(m.no))
    })
  }
}

/** 実アカウントに近い構成: 転送のみ・受信のみ・両方 */
export const sampleMails = (): MailEntry[] => [
  mail(1, "mail", "example.com", 2),
  mail(2, "shop", "example.com", 1),
  mail(3, "sns", "example.net", 1, "sub@mail.example"),
  mail(4, "mail", "example.net", 3, "me@mail.example"),
  mail(5, "bank", "example.org", 1),
]
