export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFIRMATION_REQUIRED'
  | 'FACT_NOT_CONFIGURED'
  | 'CONFLICT'
  | 'UPSTREAM_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface FieldError {
  field: string;
  code: string;
}

export interface Result<T = unknown> {
  ok: boolean;
  code: string;
  message: string;
  requestId: string;
  data: T | null;
  errors: FieldError[] | null;
}

export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ok<T>(data: T, requestId?: string): Result<T> {
  return {
    ok: true,
    code: 'OK',
    message: 'Success',
    requestId: requestId ?? generateRequestId(),
    data,
    errors: null,
  };
}

export function err<T = null>(
  code: ErrorCode,
  message: string,
  errors?: FieldError[],
  requestId?: string,
  data?: T,
): Result<T> {
  return {
    ok: false,
    code,
    message,
    requestId: requestId ?? generateRequestId(),
    data: (data ?? null) as T,
    errors: errors ?? null,
  };
}
