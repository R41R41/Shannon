export {
  ShannonError,
  LLMError,
  ToolError,
  TimeoutError,
  ErrorType,
  getErrorMessage,
  toShannonError,
} from './base.js';

export {
  ServiceError,
  RateLimitError,
  AuthenticationError,
  NetworkError,
  ServiceTimeoutError,
  type ServiceErrorCode,
} from './ServiceError.js';

export {
  classifyError,
  isRecoverable,
  formatErrorForLog,
} from './errorHandler.js';
