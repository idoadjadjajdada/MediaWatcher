/**
 * What a client is told when something throws, and what it is not.
 *
 * The failure being pinned is quiet: every status used to answer with
 * `error.message`, so a filesystem error handed the browser an absolute path
 * and a TMDB failure could hand it a URL with the API key in the query string.
 * Nothing looked broken, which is what made it worth a test rather than a
 * comment.
 *
 * Run: node tests/error-handler.test.mjs
 */
import errorHandler, { isSpeakable, GENERIC_MESSAGE, upstreamStatus } from '../middleware/errorHandler.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const logged = [];
const log = {
  error: (...args) => logged.push(['error', args.join(' ')]),
  warn: (...args) => logged.push(['warn', args.join(' ')])
};
const handle = errorHandler(log);

/** The two methods of a response the handler actually uses. */
function fakeResponse() {
  const sent = {};
  return {
    sent,
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; }
  };
}

const run = (error) => {
  const res = fakeResponse();
  handle(error, {}, res, () => {});
  return res.sent;
};

/* -------------------------------------------------------------------------
 * what reaches the client
 * ---------------------------------------------------------------------- */
console.log('\nclient errors pass through');

const forbidden = Object.assign(new Error('path is outside the library'), { status: 403 });
check('a 403 keeps its status', run(forbidden).status === 403);
check('and its message', run(forbidden).body.error === 'path is outside the library');

const notFound = Object.assign(new Error('no job 42'), { status: 404 });
check('a 404 keeps its message', run(notFound).body.error === 'no job 42');

const refused = Object.assign(new Error('Origin not allowed'), { status: 403 });
check('a refused origin is a 403, not a 500', run(refused).status === 403);

const legacy = Object.assign(new Error('bad request'), { statusCode: 400 });
check('statusCode is honoured as well as status', run(legacy).status === 400);

console.log('\nserver errors do not');

const enoent = Object.assign(
  new Error("ENOENT: no such file or directory, open 'C:\\Users\\someone\\.env'"),
  {}
);
const leaked = run(enoent);
check('an unlabelled error is a 500', leaked.status === 500);
check('and says nothing about itself', leaked.body.error === GENERIC_MESSAGE);
check('the path is not in the response', !JSON.stringify(leaked.body).includes('someone'));

const upstream = Object.assign(new Error('TMDB /movie/1?api_key=secret123: failed'), { status: 502 });
const masked = run(upstream);
check('a 502 keeps its status', masked.status === 502);
check('but not its message', masked.body.error === GENERIC_MESSAGE);
check('an API key cannot escape this way', !JSON.stringify(masked.body).includes('secret123'));

/*
 * http-errors marks a deliberate client error `expose: true` and an internal one
 * `expose: false`. A 4xx that says it must not be exposed is taken at its word.
 */
const quiet = Object.assign(new Error('internal detail'), { status: 400, expose: false });
check('an unexposable 4xx is masked too', run(quiet).body.error === GENERIC_MESSAGE);

console.log('\nthe detail still reaches the log');

logged.length = 0;
run(enoent);
check('a 500 is logged as an error', logged[0][0] === 'error');
check('with the real message', logged[0][1].includes('ENOENT'));

logged.length = 0;
run(forbidden);
check('a 4xx is logged as a warning', logged[0][0] === 'warn');

console.log('\nisSpeakable');
check('4xx speaks', isSpeakable({ message: 'x' }, 404) === true);
check('5xx does not', isSpeakable({ message: 'x' }, 500) === false);
check('expose:false silences a 4xx', isSpeakable({ expose: false }, 404) === false);

console.log('\nupstreamStatus');
// The client sends anyone who receives a 401 back to the login page, so a
// third party's rejection must never arrive wearing one.
check('an upstream 401 becomes a gateway error', upstreamStatus({ status: 401 }) === 502);
check('so does a 403', upstreamStatus({ status: 403 }) === 502);
check('a 404 is still a 404', upstreamStatus({ status: 404 }) === 404);
check('a rate limit still says so', upstreamStatus({ status: 429 }) === 429);
check('no status at all is a gateway error', upstreamStatus(new Error('socket hang up')) === 502);
check('and neither is nothing', upstreamStatus(undefined) === 502);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
