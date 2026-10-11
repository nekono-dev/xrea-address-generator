// Node.jsの入口。設定の読み込み、組み立て、起動。
import { readFileSync } from "node:fs"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createNodeSqliteClient } from "../credentials/sqliteClient"
import { consoleLogger } from "../shared/logger"
import { createGatewayApp, type GatewayFetcher } from "../gateway/app"
import { mxCheck } from "../gateway/domainCheck"
import { nodeResolver } from "../gateway/nodeResolver"
import { Registry } from "../gateway/registry"
import { buildApi } from "./api"
import { ConfigError, loadAppConfig } from "./config"
import { staticHandler } from "./static"

async function main(): Promise<void> {
  let config
  try {
    config = loadAppConfig(process.env, { readFile: p => readFileSync(p, "utf8") })
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const db = config.credentials.store === "sqlite" ? createNodeSqliteClient(config.credentials.dbPath) : undefined
  // ゲートウェイは同一プロセスの中で組み立て、ネットワークを介さずに呼び出す
  const gatewayApp = createGatewayApp({ registry: new Registry(), domainCheck: mxCheck(nodeResolver) })
  const gateway: GatewayFetcher = async (_x, req) => gatewayApp.fetch(req)
  const api = await buildApi(config, { db, gateway })
  const app = new Hono()
  app.route("/", api)
  app.get("*", staticHandler())
  serve({ fetch: app.fetch, hostname: config.bindAddress, port: config.port }, info => {
    consoleLogger.info({ msg: "started", address: info.address, port: info.port })
  })
}

void main()
