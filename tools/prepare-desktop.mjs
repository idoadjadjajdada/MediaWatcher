/** Stage an explicit, secret-free desktop payload with a matching Node ABI. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const platform = require(path.join(root, 'desktop', 'platform.cjs'));
const stage = path.join(root, '.desktop-build');
const host = platform.requireTarget();
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ is required.');
// Deletion is strictly limited to the generated staging folder in this repo.
if (path.dirname(path.resolve(stage)) !== root || path.basename(stage) !== '.desktop-build') {
  throw new Error('Refusing to clean a path outside desktop build staging.');
}
console.log(`Staging the ${host.label} ${host.arch} payload.`);
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
// Node does not promise to carry the execute bit across a copy, and a runtime
// staged without it fails at the first fork rather than here.
const copyExecutable = (from, to) => { copy(from, to); fs.chmodSync(to, 0o755); };

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
// The window, the tray and the packaged application all want an icon, and which
// file that is depends on the platform being built for.
const icons = new Set([host.windowIcon, host.trayIcon, 'icons/app.ico', 'icons/mark.png',
  'icons/icon-192.png', 'icons/icon-512.png']);
for (const file of ['css/base.css', 'css/fonts.css', ...icons]) {
  copy(path.join(root, 'public', file), path.join(shell, 'public', file));
}
fs.cpSync(path.join(root, 'public', 'fonts'), path.join(shell, 'public', 'fonts'), { recursive: true });

// The backend gets its own Node, not Electron's ABI. This leaves the original
// better-sqlite3 install usable by npm start and the existing launcher.
const stagedNode = path.join(runtime, platform.executableName('node'));
// MW_BUILD_NODE exists for Linux distribution: the build machine's Node links
// against the glibc it was installed with, and an AppImage meant to run on
// older systems wants an official Node build rather than this one.
const sourceNode = process.env.MW_BUILD_NODE ? path.resolve(process.env.MW_BUILD_NODE) : process.execPath;
copyExecutable(sourceNode, stagedNode);
const nodeVersion = execFileSync(stagedNode, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '');
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`);
if (!license.ok) throw new Error(`Unable to fetch Node license: ${license.status}`);
fs.writeFileSync(path.join(runtime, 'LICENSE.node.txt'), await license.text());
if (!process.env.npm_execpath) throw new Error('Run through npm run desktop:prepare.');
execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: backend, stdio: 'inherit', windowsHide: true
});
execFileSync(stagedNode, ['--input-type=module', '-e',
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

/** The first `name` on PATH, without asking the shell to find it for us. */
function onPath(name) {
  const file = platform.executableName(name);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, file);
    try {
      if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch { /* the next entry */ }
  }
  return null;
}

function findBinary(name) {
  const explicit = process.env[`MW_BUILD_${name.toUpperCase()}`];
  if (explicit) return path.resolve(explicit);
  const found = onPath(name);
  if (!found) throw new Error(`${name} is not on PATH. Install it, or set MW_BUILD_${name.toUpperCase()}.`);
  return found;
}

/** Whether a binary carries its dependencies, or expects to find them installed. */
function selfContained(file) {
  if (host.platform !== 'linux') return true;
  try {
    // ldd exits non-zero and says so for a static binary; a dynamic one lists
    // the libraries it wants, none of which are in the package we are building.
    const output = execFileSync('ldd', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /not a dynamic executable|statically linked/i.test(output);
  } catch (error) {
    return /not a dynamic executable|statically linked/i.test(String(error.stdout || '') + String(error.stderr || ''));
  }
}

/**
 * Whether FFmpeg travels with the application.
 *
 * On Windows it always has: there is one obvious complete distribution, its
 * DLLs sit beside the executable, and a machine without FFmpeg is the normal
 * case. On Linux neither half of that holds. The distribution's own FFmpeg is
 * a dynamically linked binary tied to a dozen system libraries, so copying it
 * into a package produces something that runs on the build machine and nowhere
 * else — and Linux users have a package manager that installs FFmpeg properly.
 *
 * So Linux looks at what it was given: a self-contained build is bundled, and
 * anything else is left to the system, where `ffmpeg` on PATH is already what
 * the server's configuration defaults to. `MW_BUILD_FFMPEG_MODE` forces either.
 */
const requested = process.env.MW_BUILD_FFMPEG_MODE || (host.platform === 'linux' ? 'auto' : 'bundle');
if (!['auto', 'bundle', 'system'].includes(requested)) {
  throw new Error(`MW_BUILD_FFMPEG_MODE must be auto, bundle or system (got ${requested}).`);
}
let bundledFfmpeg = requested !== 'system';
const ffmpegReport = {};
if (requested === 'system') {
  // Still prove it exists and runs. A package that depends on FFmpeg and was
  // built on a machine without it has never had its playback path exercised.
  for (const name of ['ffmpeg', 'ffprobe']) {
    const source = findBinary(name);
    execFileSync(source, ['-version'], { stdio: 'ignore', windowsHide: true });
    ffmpegReport[name] = `system: ${source}`;
  }
  fs.writeFileSync(path.join(bin, 'README.txt'),
    'FFmpeg is not bundled in this build. MediaWatcher uses the ffmpeg and ffprobe on PATH,\n'
    + 'or the FFMPEG_PATH and FFPROBE_PATH set in your .env.\n');
} else {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const source = findBinary(name);
    execFileSync(source, ['-version'], { stdio: 'ignore', windowsHide: true });
    if (!selfContained(source)) {
      if (requested === 'bundle') {
        throw new Error(`${source} is dynamically linked against system libraries, so a copy of it `
          + 'would only run on this machine. Point MW_BUILD_FFMPEG at a static build, or use '
          + 'MW_BUILD_FFMPEG_MODE=system to depend on the one the system installs.');
      }
      console.log(`FFmpeg at ${source} is dynamically linked; depending on the system copy instead.`);
      bundledFfmpeg = false;
      break;
    }
    copyExecutable(source, path.join(bin, platform.executableName(name)));
    for (const file of fs.readdirSync(path.dirname(source))) {
      if (host.sharedLibrary.test(file)) copy(path.join(path.dirname(source), file), path.join(bin, file));
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
    ffmpegReport[name] = `bundled: ${source}`;
  }
  if (!bundledFfmpeg) {
    // The auto path changed its mind partway through; nothing half-copied ships.
    fs.rmSync(bin, { recursive: true, force: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['ffmpeg', 'ffprobe']) ffmpegReport[name] = `system: ${findBinary(name)}`;
    fs.writeFileSync(path.join(bin, 'README.txt'),
      'FFmpeg is not bundled in this build. MediaWatcher uses the ffmpeg and ffprobe on PATH,\n'
      + 'or the FFMPEG_PATH and FFPROBE_PATH set in your .env.\n');
  }
}

const version = (file) => execFileSync(file, ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0];
fs.writeFileSync(path.join(runtime, 'versions.json'), JSON.stringify({
  node: nodeVersion, electron: pkg.devDependencies.electron,
  platform: host.platform, arch: host.arch,
  // What verify-desktop checks, and what the app's log answers "where is
  // FFmpeg" with on a machine that turns out not to have any.
  bundledFfmpeg,
  ffmpeg: version(bundledFfmpeg ? path.join(bin, platform.executableName('ffmpeg')) : findBinary('ffmpeg'))
}, null, 2));
console.log(`Desktop payload staged for ${host.platform}-${host.arch}. Node, SQLite, the updater and `
  + `FFmpeg (${bundledFfmpeg ? 'bundled' : 'from the system'}) verified; personal data excluded.`);
