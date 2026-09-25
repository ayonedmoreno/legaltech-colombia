import type { ApiErrorCode } from "@legaltech/contracts";

/**
 * A domain error that already knows its HTTP status and stable API error code
 * (packages/contracts/src/error.ts). Thrown by services and routes; caught centrally
 * by the error handler (plugins/error-handler.ts), which is the only place that talks
 * to the response object for errors.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: Array<{ field: string; issue: string }>;
  readonly headers?: Record<string, string>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    options?: {
      details?: Array<{ field: string; issue: string }>;
      headers?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details ?? [];
    this.headers = options?.headers;
  }
}
