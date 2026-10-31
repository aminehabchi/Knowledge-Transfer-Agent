/** Errors whose message is safe to show to the caller. Anything else is reported generically. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
export const unauthenticated = () => new AppError(401, "unauthenticated", "Authentication required");
export const forbidden = (message = "You do not have access to this resource") => new AppError(403, "forbidden", message);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, "conflict", message, details);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, "unprocessable", message, details);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, "rate_limited", "Too many requests, please slow down", { retryAfterSeconds });

/** Thrown by job handlers / integrations for failures that must not be retried. */
export class PermanentError extends Error {}
