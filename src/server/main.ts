// 設定の読み込み、各部品の組み立て、起動。
import { serve } from "@hono/node-server"
import { createProtonReader } from "../proton/index"
import { XreaClient } from "../xrea/client"
import { AliasService } from "./aliasService"
import { consoleLogger, createApp } from "./app"
import { ConfigError, loadConfig } from "./config"

function main(): void {
  let config
  try {
    config = loadConfig()
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const xrea = new XreaClient(config.xrea)
  const proton = createProtonReader(config.proton, { logger: consoleLogger })
  const service = new AliasService({ xrea, proton })
  const app = createApp({ service })
  serve({ fetch: app.fetch, hostname: config.bindAddress, port: config.port }, info => {
    consoleLogger.info({ msg: "started", address: info.address, port: info.port })
  })
}

main()
