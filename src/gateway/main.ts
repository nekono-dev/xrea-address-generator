// 設定の読み込み、各部品の組み立て、起動。
import { serve } from "@hono/node-server"
import { consoleLogger } from "../shared/logger"
import { createGatewayApp } from "./app"
import { ConfigError, loadGatewayConfig } from "./config"
import { Registry } from "./registry"

function main(): void {
  let config
  try {
    config = loadGatewayConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const app = createGatewayApp({ registry: new Registry(), internalToken: config.internalToken })
  serve({ fetch: app.fetch, hostname: config.bindAddress, port: config.port }, info => {
    consoleLogger.info({ msg: "started", address: info.address, port: info.port })
  })
}

main()
