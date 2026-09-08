/** Stage an explicit, secret-free Windows payload with a matching Node ABI. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.desktop-build');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build the Windows x64 app using Windows x64 Node.js.');
}
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ is required.');
// Deletion is strictly limited to the generated staging folder in this repo.
if (path.dirname(path.resolve(stage)) !== root || path.basename(stage) !== '.desktop-build') {
  throw new Error('Refusing to clean a path outside desktop build staging.');
}
fs.rmSync(stage, { recursive: true, force: true });
const backend = path.join(stage, 'backend');
const shell = path.join(stage, 'shell');
const runtime = path.join(stage, 'runtime');
const bin = path.join(stage, 'bin');
for (const dir of [backend, shell, runtime, bin]) fs.mkdirSync(dir, { recursive: true });
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

// Only runtime source/assets, never the working tree's db, keys, media or logs.
for (const dir of ['config', 'db', 'middleware', 'routes', 'services']) {
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|sql)$/.test(entry.name)) copy(path.join(root, file), path.join(backend, file));
    }
  };
  walk(dir);
}
for (const file of ['server.js', '.env.example', 'package.json', 'package-lock.json']) {
  copy(path.join(root, file), path.join(backend, file));
}
fs.cpSync(path.join(root, 'public'), path.join(backend, 'public'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(shell, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description,
  author: 'MediaWatcher', main: 'desktop/main.cjs', private: true,
  // The shell checks GitHub releases itself; the backend never sees an updater.
  dependencies: { 'electron-updater': pkg.dependencies['electron-updater'] }
}, null, 2));
fs.cpSync(path.join(root, 'desktop'), path.join(shell, 'desktop'), { recursive: true });
for (const file of ['css/base.css', 'css/fonts.css', 'icons/app.ico', 'icons/mark.png']) {
  copy(path.join(root, 'public', file), path.join(shell, 'public', file));
}
fs.cpSync(path.join(root, 'public', 'fonts'), path.join(shell, 'public', 'fonts'), { recursive: true });

// The backend gets its own Node, not Electron's ABI. This leaves the original
// better-sqlite3 install usable by npm start and the existing launcher.
copy(process.execPath, path.join(runtime, 'node.exe'));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
if (!license.ok) throw new Error(`Unable to fetch Node license: ${license.status}`);
fs.writeFileSync(path.join(runtime, 'LICENSE.node.txt'), await license.text());
if (!process.env.npm_execpath) throw new Error('Run through npm run desktop:prepare.');
execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: backend, stdio: 'inherit', windowsHide: true
});
execFileSync(path.join(runtime, 'node.exe'), ['--input-type=module', '-e',
  "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.exec('CREATE TABLE smoke (id INTEGER)'); db.close();"
], { cwd: backend, stdio: 'inherit', windowsHide: true });
// Electron runs the shell, so its one dependency installs against Electron's
// own tree rather than the backend's. A missing updater must fail here, not
// silently ship an app that can never find its next release.
execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: shell, stdio: 'inherit', windowsHide: true
});
execFileSync(process.execPath, ['-e', "require.resolve('electron-updater')"], {
  cwd: shell, stdio: 'inherit', windowsHide: true
});

function findBinary(name) {
  const explicit = process.env[`MW_BUILD_${name.toUpperCase()}`];
  if (explicit) return path.resolve(explicit);
  return execFileSync('where.exe', [`${name}.exe`], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
}
for (const name of ['ffmpeg', 'ffprobe']) {
  const source = findBinary(name);
  execFileSync(source, ['-version'], { stdio: 'ignore', windowsHide: true });
  copy(source, path.join(bin, `${name}.exe`));
  for (const file of fs.readdirSync(path.dirname(source))) {
    if (/\.dll$/i.test(file)) copy(path.join(path.dirname(source), file), path.join(bin, file));
  }
  const distribution = path.dirname(path.dirname(source));
  const licenseDir = path.join(bin, `${name}-notices`);
  const licenseFiles = fs.readdirSync(distribution).filter((file) => /^(license|copying|readme)/i.test(file)
    && fs.statSync(path.join(distribution, file)).isFile());
  if (!licenseFiles.some((file) => /^(license|copying)/i.test(file))) {
    throw new Error(`No FFmpeg license found in ${distribution}. Use a complete FFmpeg distribution with its LICENSE.`);
  }
  for (const file of licenseFiles) copy(path.join(distribution, file), path.join(licenseDir, file));
  if (fs.existsSync(path.join(distribution, 'doc'))) {
    fs.cpSync(path.join(distribution, 'doc'), path.join(licenseDir, 'doc'), { recursive: true });
  }
}
fs.writeFileSync(path.join(runtime, 'versions.json'), JSON.stringify({
  node: process.versions.node, electron: pkg.devDependencies.electron,
  platform: process.platform, arch: process.arch,
  ffmpeg: execFileSync(path.join(bin, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]
}, null, 2));
console.log('Desktop payload staged. Node, SQLite, FFmpeg and the updater verified; personal data excluded.');
