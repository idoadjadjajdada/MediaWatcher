/**
 * The installer's maintenance page, compiled.
 *
 * NSIS expands a define where it parses it, and electron-builder prepends this
 * script ahead of the includes that define most of them — so a line that reads
 * perfectly well can compile to nothing and warn about it. Warnings are errors
 * to electron-builder, which means the failure arrives at the end of a
 * four-minute packaging run, twice in a row, for a two-character mistake.
 *
 * So the script is compiled here instead, in about a second, against a harness
 * that supplies what the real build supplies. Skipped where makensis has not
 * been downloaded yet; the packaging run still catches it there.
 *
 * Run: node tests/installer.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'build/installer.nsh');
const source = fs.readFileSync(script, 'utf8');

// The two runs that must never see the page, and the reason each is skipped.
assert.match(source, /\$\{If\} \$\{Silent\}/, 'a silent install has nobody to ask');
assert.match(source, /"--updated"/, 'an update the app performs has already been agreed to');
assert.match(source, /UNINSTALL_REGISTRY_KEY/, 'it reads what is already installed');
// Every define is read inside the macro, which is expanded after they exist.
const macro = source.slice(source.indexOf('!macro customWelcomePage'));
for (const define of ['${UNINSTALL_REGISTRY_KEY}', '${VERSION}']) {
  assert.equal(source.indexOf(define) >= source.indexOf('!macro customWelcomePage'), true,
    `${define} is used before the macro that makes it available`);
  assert.ok(macro.includes(define));
}
console.log('PASS: the page skips the runs it must skip, and reads defines where they exist');

const cache = path.join(os.homedir(), 'AppData/Local/electron-builder/Cache');
const makensis = fs.existsSync(cache)
  ? fs.readdirSync(cache)
    .filter((entry) => entry.startsWith('nsis-'))
    .flatMap((entry) => {
      const dir = path.join(cache, entry);
      return fs.readdirSync(dir).map((inner) => path.join(dir, inner, 'Bin/makensis.exe'));
    })
    .find((candidate) => fs.existsSync(candidate))
  : null;

if (!makensis) {
  console.log('SKIP: makensis is not downloaded yet — run a packaging build once');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mediawatcher-nsis-'));
try {
  // What electron-builder's generated script provides by the time the macro is
  // inserted: the registry key, the version, and MUI2 for the header text.
  const harness = path.join(scratch, 'harness.nsi');
  fs.writeFileSync(harness, [
    '!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\mediawatcher-test"',
    '!define VERSION "0.0.0"',
    '!include "MUI2.nsh"',
    `!include "${script.replace(/\\/g, '\\\\')}"`,
    'Name "MediaWatcher test harness"',
    `OutFile "${path.join(scratch, 'harness.exe').replace(/\\/g, '\\\\')}"`,
    '!insertmacro customWelcomePage',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "English"',
    'Section "Main"',
    'SectionEnd',
    ''
  ].join('\n'));

  // -WX is what the packaging build uses: a warning here is a broken installer.
  const output = execFileSync(makensis, ['-WX', '-V2', harness], { encoding: 'utf8', windowsHide: true });
  assert.equal(output.includes('warning'), false, output);
  assert.equal(fs.existsSync(path.join(scratch, 'harness.exe')), true, 'it produced an installer');
  console.log('PASS: build/installer.nsh compiles with warnings treated as errors');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
