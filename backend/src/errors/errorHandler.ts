/**
 * Unified error classification and formatting utilities.
 *
 * Use `classifyError` in catch blocks to turn an unknown thrown value into a
 * well-typed `ServiceError`.  Use `isRecoverable` for quick guard checks and
 * `formatErrorForLog` for consistent logging output.
 */

import {
  ServiceError,
  RateLimitError,
  AuthenticationError,
  NetworkError,
  ServiceTimeoutError,
  type ServiceErrorCode,
} from './ServiceError.js';

// ── Heuristic keyword maps ──────────────────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /quota/i,
];

const AUTH_PATTERNS = [
  /auth/i,
  /unauthorized/i,
  /forbidden/i,
  /401/,
  /403/,
  /token.*invalid/i,
  /login.*fail/i,
];

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed?\s*out/i,
  /ETIMEDOUT/,
  /ESOCKETTIMEDOUT/,
  /AbortError/i,
];

const NETWORK_PATTERNS = [
  /network/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /EPIPE/,
  /socket hang up/i,
  /fetch failed/i,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function extractStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (typeof e.code === 'number') return e.code;
    // Axios-style
    if (e.response && typeof e.response === 'object') {
      const resp = e.response as Record<string, unknown>;
      if (typeof resp.status === 'number') return resp.status;
    }
  }
  return undefined;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify an unknown thrown value into a typed `ServiceError`.
 *
 * Already-classified `ServiceError` instances are returned as-is.
 */
export function classifyError(error: unknown, service: string): ServiceError {
  // Pass-through if already classified
  if (error instanceof ServiceError) return error;

  const msg = extractMessage(error);
  const status = extractStatusCode(error);

  // 1. Rate-limit
  if (status === 429 || matchesAny(msg, RATE_LIMIT_PATTERNS)) {
    return new RateLimitError(service, undefined, error);
  }

  // 2. Auth
  if (status === 401 || status === 403 || matchesAny(msg, AUTH_PATTERNS)) {
    return new AuthenticationError(service, msg, error);
  }

  // 3. Timeout
  if (matchesAny(msg, TIMEOUT_PATTERNS)) {
    return new ServiceTimeoutError(service, undefined, error);
  }

  // 4. Network
  if (matchesAny(msg, NETWORK_PATTERNS)) {
    return new NetworkError(service, msg, error);
  }

  // 5. Fallback — generic ServiceError
  const code: ServiceErrorCode = status && status >= 500 ? 'API_ERROR' : 'UNKNOWN';
  const recoverable = code === 'API_ERROR'; // 5xx are usually transient
  return new ServiceError(
    `[${service}] ${msg}`,
    service,
    code,
    recoverable,
    error,
  );
}

/**
 * Quick predicate: can the caller reasonably retry this error?
 */
export function isRecoverable(error: unknown): boolean {
  if (error instanceof ServiceError) return error.recoverable;
  // Unknown errors are *not* assumed to be recoverable.
  return false;
}

/**
 * Return a single-line log string with consistent structure.
 *
 * Format: `[SERVICE] CODE | message (recoverable: yes/no)`
 */
export function formatErrorForLog(error: ServiceError): string {
  const recov = error.recoverable ? 'yes' : 'no';
  return `[${error.service}] ${error.serviceCode} | ${error.message} (recoverable: ${recov})`;
}
