// アプリ共通のエラーコードと状態コードの対応。
export type ErrorCode =
  | "validation_error"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "rate_limited"
  | "unauthorized"
  | "credentials_required"
  | "invalid_credentials"

export const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 502 | 503> = {
  validation_error: 400,
  invalid_credentials: 400,
  credentials_required: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream_error: 502,
  rate_limited: 503,
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AppError"
  }
}

export function errorBody(code: ErrorCode | "internal_error", message: string) {
  return { error: { code, message } }
}
