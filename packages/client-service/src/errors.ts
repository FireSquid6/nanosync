export class ClientError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 2) { super(message); }
}
