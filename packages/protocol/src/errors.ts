export type ProtocolValidationErrorCode =
  | "INVALID_TYPE"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "INVALID_VALUE"
  | "LIMIT_EXCEEDED"
  | "UNSUPPORTED_VERSION"
  | "INVALID_ORDER"
  | "DUPLICATE_VALUE";

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationErrorCode;
  readonly path: string;

  constructor(code: ProtocolValidationErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }
}
