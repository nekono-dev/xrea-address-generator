// 構造化ログ。1行1JSONで標準出力・標準エラーへ書く。
export type Logger = { info(o: object): void; warn(o: object): void; error(o: object): void }

export const consoleLogger: Logger = {
  info: o => console.log(JSON.stringify({ level: "info", ...o })),
  warn: o => console.warn(JSON.stringify({ level: "warn", ...o })),
  error: o => console.error(JSON.stringify({ level: "error", ...o })),
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
