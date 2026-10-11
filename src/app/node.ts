// Node.jsの入口。設定の読み込み、組み立て、起動。
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createNodeSqliteClient } from "../credentials/sqliteClient"
import { consoleLogger } from "../shared/logger"
import { buildApi } from "./api"
import { ConfigError, loadAppConfig } from "./config"
import { staticHandler } from "./static"

async function main(): Promise<void> {
  let config
  try {
    config = loadAppConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const db = config.credentials.store === "sqlite" ? createNodeSqliteClient(config.credentials.dbPath) : undefined
  const api = await buildApi(config, { db })
  const app = new Hono()
  app.route("/", api)
  app.get("*", staticHandler())
  serve({ fetch: app.fetch, hostname: config.bindAddress, port: config.port }, info => {
    consoleLogger.info({ msg: "started", address: info.address, port: info.port })
  })
}

void main()
