/**
 * The last handler on the stack: what a client is told when something throws.
 *
 * The rule is that the client is told what it can act on and nothing else.
 *
 *   4xx  written for the caller — "path is outside the library", "file not
 *        found" — and safe to pass through verbatim.
 *   5xx  whatever threw. An ENOENT carrying an absolute path, a TMDB URL with
 *        the API key in it, a database error naming columns. This used to go
 *        straight to the browser for every status.
 *
 * Separated from server.js so the rule can be tested against a fake response
 * instead of by reading it and hoping.
 */
export const GENERIC_MESSAGE = 'Internal server error';

/** Should this error's own message reach the client? */
export function isSpeakable(error, status) {
  if (status >= 500) return false;
  // `expose` is what http-errors sets on a deliberate client error. An error
  // that reached here by being thrown carries no such promise, but the ones
  // this app raises on purpose set a status and mean their message.
  return error?.expose !== false;
}

/** Build the handler. `log` is injected so a test does not print. */
export default function errorHandler(log) {
  return (error, _req, res, _next) => {
    const status = error?.status || error?.statusCode || 500;

    if (status >= 500) log.error(error?.stack || error?.message);
    else log.warn(error?.message);

    res.status(status).json({
      error: isSpeakable(error, status) ? error.message : GENERIC_MESSAGE
    });
  };
}
