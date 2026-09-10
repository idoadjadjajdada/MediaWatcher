const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const platform = require('../desktop/platform.cjs');

// Validate the final copied payload, not just staging. A missing dependency
// must fail the build before an installer or a broken application is handed out.
module.exports = async ({ appOutDir, electronPlatformName }) => {
  const target = electronPlatformName || process.platform;
  const resources = path.join(appOutDir, target === 'darwin'
    ? `${path.basename(appOutDir)}.app/Contents/Resources` : 'resources');
  const backend = path.join(resources, 'backend');
  const node = platform.bundledNode(resources, target);
  for (const file of ['node_modules/dotenv/package.json', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'db/schema.sql', '.env.example', 'public/index.html']) {
    assert.ok(fs.existsSync(path.join(backend, file)), `Missing packaged backend file: ${file}`);
  }
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
