export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ControlError'
  }
}

export function errorResponse(error: unknown): Response {
  const known = error instanceof ControlError
    ? error
    : new ControlError('internal_error', 'Agent Control request failed.', 500)
  return Response.json({
    ok: false,
    error: { code: known.code, message: known.message, status: known.status, retryable: known.retryable },
  }, { status: known.status, headers: { 'cache-control': 'no-store' } })
}
