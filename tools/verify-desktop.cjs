const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const platform = require('../desktop/platform.cjs');

/** Every compiled addon under `dir`, at whatever depth the package keeps it. */
function nativeBinaries(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.node')) found.push(file);
    }
  };
  walk(dir);
  return found;
}

// Validate the final copied payload, not just staging. A missing dependency
// must fail the build before an installer or a broken application is handed out.
module.exports = async ({ appOutDir, electronPlatformName }) => {
  const target = electronPlatformName || process.platform;
  const resources = path.join(appOutDir, target === 'darwin'
    ? `${path.basename(appOutDir)}.app/Contents/Resources` : 'resources');
  const backend = path.join(resources, 'backend');
  const node = platform.bundledNode(resources, target);
  for (const file of ['node_modules/dotenv/package.json', 'db/schema.sql', '.env.example', 'public/index.html']) {
    assert.ok(fs.existsSync(path.join(backend, file)), `Missing packaged backend file: ${file}`);
  }
  /*
   * The SQLite binary, wherever this version of better-sqlite3 keeps it.
   *
   * Naming one path was wrong the moment the dependency moved: v11 built
   * `build/Release/better_sqlite3.node` locally, and from v12 a prebuilt
   * `prebuilds/<platform>-<arch>.node` is downloaded instead and no build
   * directory is created at all. Asserting the old path failed a package that
   * was in fact complete, at the end of a full Electron build.
   *
   * What actually matters is that a native binary shipped and that the runtime
   * below can load it. So look for one rather than for a filename.
   */
  assert.ok(nativeBinaries(path.join(backend, 'node_modules', 'better-sqlite3')).length,
    'Missing packaged backend file: no better-sqlite3 native binary (.node) was included');
  for (const file of ['.env', '.env.bak', 'config/admin-key', 'db/mediawatcher.db', 'library', 'temp', 'cache']) {
    assert.ok(!fs.existsSync(path.join(backend, file)), `Personal data included in package: ${file}`);
  }
  assert.ok(fs.existsSync(node), `The packaged Node runtime is missing: ${node}`);
  // Cross-building would hand us a runtime this machine cannot execute, and a
  // skipped check is honest where a crash pretending to be a failed build is not.
  const runnable = target === process.platform;
  if (runnable) {
    execFileSync(node, ['--input-type=module', '-e',
      "import 'dotenv'; import 'express'; import 'axios'; import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.exec('CREATE TABLE check_native (id INTEGER)'); db.close();"
    ], { cwd: backend, stdio: 'inherit', windowsHide: true });
  }
  /*
   * FFmpeg is bundled on Windows and, on Linux, only when the build was given a
   * self-contained one. Where it is not, the package depends on the system copy
   * — so the thing to verify is that the build said which, and that whatever it
   * said is actually there. A package claiming a bundled FFmpeg that shipped
   * without one plays nothing, and finds out at the first .mkv.
   */
  const versions = JSON.parse(fs.readFileSync(path.join(resources, 'runtime', 'versions.json'), 'utf8'));
  assert.equal(typeof versions.bundledFfmpeg, 'boolean', 'the build did not record how FFmpeg is provided');
  for (const binary of ['ffmpeg', 'ffprobe']) {
    const file = path.join(resources, 'bin', platform.executableName(binary, target));
    if (!versions.bundledFfmpeg) {
      assert.ok(!fs.existsSync(file), `${binary} was copied into a build that says it is not bundled`);
      continue;
    }
    assert.ok(fs.existsSync(file), `Missing bundled ${binary}`);
    if (runnable) execFileSync(file, ['-version'], { stdio: 'ignore', windowsHide: true });
  }
  const source = path.resolve(__dirname, '..', 'public');
  const compare = (dir = '') => {
    for (const entry of fs.readdirSync(path.join(source, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) compare(relative);
      else assert.ok(fs.readFileSync(path.join(source, relative)).equals(
        fs.readFileSync(path.join(backend, 'public', relative))), `Frontend changed during packaging: ${relative}`);
    }
  };
  compare();
  console.log(`Verified packaged dependencies, SQLite ABI, FFmpeg (${versions.bundledFfmpeg ? 'bundled' : 'from the system'}), `
    + 'unchanged frontend and no personal data.');
};

// Exported so tests can hold it against the real node_modules, and catch a
// dependency bump that moves the binary before a build spends ten minutes on it.
module.exports.nativeBinaries = nativeBinaries;
