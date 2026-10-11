// Workers（workerd）上で cookie 方式の保存と取り出しを行う試験用エントリ
import { createCookieStore } from "../../../src/credentials/cookieStore"
import { deriveKey } from "../../../src/credentials/seal"

export default {
  async fetch(req: Request): Promise<Response> {
    const store = createCookieStore(await deriveKey("a".repeat(32)), { secure: true })
    if (new URL(req.url).pathname === "/save") {
      const set = await store.save(await req.json())
      return new Response(null, { status: 204, headers: { "Set-Cookie": set } })
    }
    return Response.json(await store.load(req.headers.get("cookie")))
  },
}
