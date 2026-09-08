const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Validate the final copied payload, not just staging. A missing dependency
// must fail the build before an installer or a broken EXE is handed out.
module.exports = async ({ appOutDir }) => {
  const resources = path.join(appOutDir, 'resources');
  const backend = path.join(resources, 'backend');
  const node = path.join(resources, 'runtime/node.exe');
  for (const file of ['node_modules/dotenv/package.json', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'db/schema.sql', '.env.example', 'public/index.html']) {
    assert.ok(fs.existsSync(path.join(backend, file)), `Missing packaged backend file: ${file}`);
  }
  for (const file of ['.env', '.env.bak', 'config/admin-key', 'db/mediawatcher.db', 'library', 'temp', 'cache']) {
    assert.ok(!fs.existsSync(path.join(backend, file)), `Personal data included in package: ${file}`);
  }
  execFileSync(node, ['--input-type=module', '-e',
    "import 'dotenv'; import 'express'; import 'axios'; import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.exec('CREATE TABLE check_native (id INTEGER)'); db.close();"
  ], { cwd: backend, stdio: 'inherit', windowsHide: true });
  for (const binary of ['ffmpeg', 'ffprobe']) {
    execFileSync(path.join(resources, 'bin', `${binary}.exe`), ['-version'], { stdio: 'ignore', windowsHide: true });
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
  console.log('Verified packaged dependencies, SQLite ABI, FFmpeg, unchanged frontend and no personal data.');
};
