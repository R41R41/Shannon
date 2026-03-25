/**
 * Service-layer error hierarchy.
 *
 * Provides typed, classifiable errors for cross-service concerns such as
 * rate-limiting, authentication failures, network issues, and timeouts.
 * Every ServiceError carries enough context for the caller to decide
 * whether a retry is worthwhile.
 */

import { ShannonError, ErrorType } from './base.js';

// ── Error codes ──────────────────────────────────────────────────────────────

export type ServiceErrorCode =
  | 'RATE_LIMIT'
  | 'AUTH_FAILED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'API_ERROR'
  | 'UNKNOWN';

// ── Base class ───────────────────────────────────────────────────────────────

/**
 * Base error for all service-layer failures.
 */
export class ServiceError extends ShannonError {
  /** Which service threw the error (e.g. 'twitter', 'discord', 'llm'). */
  public readonly service: string;

  /** Machine-readable error code. */
  public readonly serviceCode: ServiceErrorCode;

  /** Whether the caller can reasonably retry. */
  public readonly recoverable: boolean;

  /** The raw error that was caught, if any. */
  public readonly originalError?: unknown;

  constructor(
    message: string,
    service: string,
    serviceCode: ServiceErrorCode,
    recoverable: boolean,
    originalError?: unknown,
    errorType: ErrorType = ErrorType.UNKNOWN,
  ) {
    super(message, errorType, serviceCode);
    this.name = 'ServiceError';
    this.service = service;
    this.serviceCode = serviceCode;
    this.recoverable = recoverable;
    this.originalError = originalError;
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      service: this.service,
      serviceCode: this.serviceCode,
      recoverable: this.recoverable,
    };
  }
}

// ── Subclasses ───────────────────────────────────────────────────────────────

export class RateLimitError extends ServiceError {
  /** Seconds until the rate-limit resets (if known). */
  public readonly retryAfterMs?: number;

  constructor(service: string, retryAfterMs?: number, originalError?: unknown) {
    const msg = retryAfterMs
      ? `[${service}] Rate-limited — retry after ${retryAfterMs}ms`
      : `[${service}] Rate-limited`;
    super(msg, service, 'RATE_LIMIT', true, originalError);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthenticationError extends ServiceError {
  constructor(service: string, detail?: string, originalError?: unknown) {
    super(
      `[${service}] Authentication failed${detail ? `: ${detail}` : ''}`,
      service,
      'AUTH_FAILED',
      false,
      originalError,
    );
    this.name = 'AuthenticationError';
  }
}

export class NetworkError extends ServiceError {
  constructor(service: string, detail?: string, originalError?: unknown) {
    super(
      `[${service}] Network error${detail ? `: ${detail}` : ''}`,
      service,
      'NETWORK_ERROR',
      true,
      originalError,
    );
    this.name = 'NetworkError';
  }
}

export class ServiceTimeoutError extends ServiceError {
  public readonly timeoutMs?: number;

  constructor(service: string, timeoutMs?: number, originalError?: unknown) {
    const msg = timeoutMs
      ? `[${service}] Timed out after ${timeoutMs}ms`
      : `[${service}] Timed out`;
    super(msg, service, 'TIMEOUT', true, originalError);
    this.name = 'ServiceTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
