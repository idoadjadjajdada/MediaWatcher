/**
 * Ending the process on purpose.
 *
 * The shutdown sequence lives in server.js, which nothing may import: it is
 * the top of the graph, and a route reaching back up into it would make every
 * route depend on the whole application. So server.js registers its handler
 * here and a route asks for a restart through this instead.
 *
 * The distinction that matters is the exit code. The launcher supervises the
 * server and restarts it when it dies, backing off each time and giving up
 * after five failures — behaviour that exists for a server that cannot stay
 * up, and that would be exactly wrong for one that was asked to restart. A
 * requested restart exits with RESTART_EXIT_CODE, which the supervisor treats
 * as immediate and does not count against the budget.
 */
import { createLogger } from '../config/index.js';

const log = createLogger('lifecycle');

/**
 * 75 is EX_TEMPFAIL: "try again". Any code would do as long as it is not one
 * a crash produces, and borrowing a convention beats inventing a number.
 */
export const RESTART_EXIT_CODE = 75;

let handler = null;

/** Register the shutdown sequence. Called once, by server.js. */
export function onShutdown(fn) {
  handler = fn;
}

/**
 * Shut down and exit asking to be restarted. False when nothing can act on it.
 *
 * Returning rather than throwing because the caller is an HTTP handler that
 * has to answer before the process goes away: it needs to know whether the
 * answer is "restarting" or "there is nothing here that could".
 */
export function requestRestart(reason = 'requested') {
  if (!handler) return false;
  log.info(`restart ${reason}`);
  /*
   * On a tick of its own so the response is written first. Shutting down
   * inside the handler closes the socket before the body reaches the client,
   * which looks exactly like the server having crashed — the one impression a
   * deliberate restart must not give.
   */
  setTimeout(() => handler('restart', RESTART_EXIT_CODE), 100).unref();
  return true;
}

export default { onShutdown, requestRestart, RESTART_EXIT_CODE };
