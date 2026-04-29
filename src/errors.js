export class FizzySymphonyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FizzySymphonyError";
    this.code = code;
    this.details = details;
  }
}

export function issue(code, message, details = {}) {
  return { code, message, details };
}

export function isFizzySymphonyError(error) {
  return error instanceof FizzySymphonyError || Boolean(error?.code);
}
