/** HTTP error carrying a status and a machine-readable code. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code machine-readable code
   * @param {string} message human-readable message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new HttpError(404, code, message);

/** Domain error named in modules.md: AppError(code, message, status). Same type as HttpError. */
export class AppError extends HttpError {
  constructor(code, message, status = 400) {
    super(status, code, message);
    this.name = 'AppError';
  }
}
