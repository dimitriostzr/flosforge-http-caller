/** An error with a message meant for the user and a short code (shown under it). */
export class ExecError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}
