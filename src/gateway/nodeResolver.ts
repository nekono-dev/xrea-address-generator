// Node.js の名前解決。Workers のスクリプトには含めない。
import dns from "node:dns/promises"
import type { Resolver } from "./domainCheck"

export const nodeResolver: Resolver = dns
