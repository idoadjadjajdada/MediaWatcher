/**
 * Telling one MediaWatcher from another.
 *
 * The desktop app decides whether to join a running server or start beside it
 * by comparing what `/api/health` reports against a value it computes itself,
 * in a different language runtime, from a different copy of the rule. The two
 * agreeing is the whole mechanism, so it is the test: if they ever drift, the
 * app either duplicates a library or refuses to open next to a stranger.
 *
 * Run: node tests/instance.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { instanceFingerprint } from '../services/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { fingerprint } = require(path.join(root, 'desktop/instance.cjs'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mediawatcher-instance-'));
const library = (name, key) => {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (key !== null) fs.writeFileSync(path.join(dir, 'config', 'admin-key'), key);
  return dir;
};

try {
  const key = 'a'.repeat(64);
  const mine = library('mine', key);

  // The shell reads the key off disk; the server already has it in config.
  assert.equal(fingerprint(mine), instanceFingerprint(mine, key));
  assert.match(fingerprint(mine), /^[0-9a-f]{32}$/);
  console.log('PASS: the desktop shell and the server compute the same answer');

  // A trailing newline is what a text editor leaves behind.
  const spaced = library('spaced', `${key}\n`);
  assert.equal(fingerprint(spaced), instanceFingerprint(spaced, key));

  const other = library('other', key);
  assert.notEqual(fingerprint(other), fingerprint(mine),
    'two libraries sharing a key are still two libraries');

  const different = library('different', 'b'.repeat(64));
  assert.notEqual(fingerprint(different), instanceFingerprint(different, key),
    'the key is what proves it, not the path');
  console.log('PASS: a different folder or a different key is a different instance');

  // Nothing to prove with. Anything on the port is then a stranger, which is
  // the safe way to be wrong: start beside it rather than share its library.
  assert.equal(fingerprint(library('empty', null)), '');
  assert.equal(fingerprint(library('short', 'abc')), '');
  assert.equal(fingerprint(path.join(scratch, 'absent')), '');
  assert.equal(fingerprint(''), '');
  assert.equal(instanceFingerprint(mine, ''), '');
  assert.equal(instanceFingerprint(mine, 'abc'), '');
  console.log('PASS: no readable key means no claim to any library');

  // The value is derived, not stored, and says nothing about where it came from.
  assert.equal(fingerprint(mine).includes(path.basename(mine)), false);
  assert.equal(fingerprint(mine), fingerprint(`${mine}${path.sep}`), 'the path is resolved first');
  console.log('PASS: the same folder named two ways is one instance');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
