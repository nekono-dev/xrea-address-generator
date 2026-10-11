// 設定の読み込み、各部品の組み立て、起動。
import { serve } from "@hono/node-server"
import { consoleLogger } from "../shared/logger"
import { createReaderApp } from "./app"
import { ConfigError, loadReaderConfig } from "./config"
import { Tenants } from "./tenants"

function main(): void {
  let config
  try {
    config = loadReaderConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const tenants = new Tenants(config.maxTenants, config.sessionDir, { logger: consoleLogger })
  const app = createReaderApp({ tenants, internalToken: config.internalToken })
  serve({ fetch: app.fetch, hostname: config.bindAddress, port: config.port }, info => {
    consoleLogger.info({ msg: "started", address: info.address, port: info.port })
  })
}

main()
