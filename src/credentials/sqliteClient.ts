// Node.js 組み込みSQLiteによる SqlClient の実装。同期APIを非同期に包む。
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SqlClient } from "./sqliteStore"

export function createNodeSqliteClient(dbPath: string): SqlClient {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  return {
    async execute(sql, params = []) {
      db.prepare(sql).run(...params)
    },
    async query<T>(sql: string, params: ReadonlyArray<string | number> = []) {
      return db.prepare(sql).all(...params) as T[]
    },
  }
}
