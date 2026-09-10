/**
 * What has to be true for this to install as an application, on either platform.
 *
 * The packaging surface is the part that cannot be checked by running the app:
 * a wrong executable name or a desktop entry pointing at nothing produces a
 * build that succeeds, an installer that installs, and a launcher icon that
 * does nothing when clicked. None of it fails until somebody has already
 * shipped it, so it is asserted here instead — against the config, the scripts
 * and the packaging files, none of which needs a build to read.
 *
 * Run: node tests/packaging.test.mjs   (or: npm run test:packaging)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const platform = require(path.join(root, 'desktop', 'platform.cjs'));
const builder = require(path.join(root, 'electron-builder.cjs'));
const pkg = JSON.parse(read('package.json'));

/* --------------------------------------------------------------------------
 * The platform facts every other file asks for
 * ----------------------------------------------------------------------- */

assert.equal(platform.executableName('node', 'win32'), 'node.exe');
assert.equal(platform.executableName('node', 'linux'), 'node');
assert.equal(platform.executableName('ffprobe', 'linux'), 'ffprobe');
assert.match(platform.bundledNode('/app/resources', 'linux'), /resources[/\\]runtime[/\\]node$/);
assert.match(platform.bundledNode('C:\\app\\resources', 'win32'), /runtime[/\\]node\.exe$/);
assert.ok(platform.target('linux', 'x64'), 'Linux x64 is a build target');
assert.ok(platform.target('linux', 'arm64'), 'Linux arm64 is a build target');
assert.equal(platform.target('linux', 'ia32'), null, '32-bit Linux is not claimed');
assert.throws(() => platform.requireTarget('sunos', 'x64'), /No desktop build/);
// The icons named for each platform have to be files that exist, because a
// missing one is an Electron window with the default icon and no error.
for (const name of ['win32', 'linux']) {
  for (const icon of [platform.target(name, 'x64').windowIcon, platform.target(name, 'x64').trayIcon]) {
    assert.ok(fs.existsSync(path.join(root, 'public', icon)), `Missing ${name} icon: ${icon}`);
  }
}
assert.equal(platform.target('linux', 'x64').windowIcon.endsWith('.png'), true, 'Linux cannot use an .ico');
assert.equal(platform.target('linux', 'x64').trayIcon.endsWith('.png'), true, 'Linux cannot use an .ico');
console.log('PASS: executable names, bundled Node paths, targets and per-platform icons');

/* --------------------------------------------------------------------------
 * Who is allowed to replace the application
 * ----------------------------------------------------------------------- */

assert.equal(platform.selfUpdating({ platform: 'win32', packaged: true }), true);
assert.equal(platform.selfUpdating({ platform: 'win32', packaged: false }), false,
  'running from source has no installer to replace');
assert.equal(platform.selfUpdating({ platform: 'linux', packaged: true, env: {} }), false,
  'a package manager owns the files of anything that is not an AppImage');
assert.equal(platform.selfUpdating({ platform: 'linux', packaged: true, env: { APPIMAGE: '/tmp/a.AppImage' } }), true);
assert.match(platform.updateHint({ platform: 'linux', env: { MW_LINUX_PACKAGE: 'pacman' } }), /pacman/);
console.log('PASS: only an installer and an AppImage may replace themselves');

const { createUpdates } = require(path.join(root, 'desktop/updater.cjs'));
const { isNewer } = require(path.join(root, 'desktop/updater.cjs'));
assert.equal(isNewer('1.5.0', '1.4.1'), true);
assert.equal(isNewer('1.4.1', '1.4.1'), false);
assert.equal(isNewer('1.4.0', '1.4.1'), false);
assert.equal(isNewer('v1.10.0', '1.9.9'), true, 'ten is after nine, not before it');

function unmanaged(fetchLatest) {
  const states = [];
  const updates = createUpdates({
    version: '1.4.1', packaged: true, repository: 'owner/repository',
    selfUpdating: false, installHint: 'Use pacman.', fetchLatest,
    makeUpdater: () => { throw new Error('an unmanaged copy must never build an updater'); },
    saveRepository: () => {}, changed: (state) => states.push(state),
    beforeInstall: async () => {}, installFailed: async () => {}
  });
  return { updates, states };
}
{
  const { updates } = unmanaged(async () => '1.5.0');
  const state = await updates.check();
  assert.equal(state.status, 'unmanaged');
  assert.equal(state.latestVersion, '1.5.0');
  assert.equal(state.installHint, 'Use pacman.');
  // Nothing to download and nothing to install: both are refused rather than
  // handed to an updater that would try to overwrite pacman's files.
  assert.equal((await updates.download()).status, 'unmanaged');
  assert.equal((await updates.install()).status, 'unmanaged');
}
{
  const { updates } = unmanaged(async () => '1.4.1');
  assert.equal((await updates.check()).latestVersion, null, 'the current version is not an update');
}
{
  const { updates } = unmanaged(async () => { throw new Error('offline'); });
  const state = await updates.check();
  assert.equal(state.status, 'unmanaged', 'a failed lookup is still an unmanaged install');
  assert.match(state.error, /connection/);
}
console.log('PASS: an unmanaged install reports releases and installs none of them');

/* --------------------------------------------------------------------------
 * The build configuration
 * ----------------------------------------------------------------------- */

const targets = builder.linux.target.map((each) => each.target);
assert.ok(targets.includes('AppImage'), 'the AppImage is the only self-updating Linux format');
assert.ok(targets.includes('pacman'), 'Arch gets a package pacman can own');
assert.equal(builder.linux.executableName, 'mediawatcher');
assert.ok(builder.pacman.depends.includes('ffmpeg'),
  'FFmpeg is not bundled on Linux, so the package has to depend on it');
assert.ok(builder.linux.icon.endsWith('.png'), 'Linux takes a PNG icon');
assert.ok(fs.existsSync(path.join(root, builder.linux.icon)), `Missing ${builder.linux.icon}`);
assert.equal(builder.linux.desktop.entry.StartupWMClass, 'MediaWatcher',
  'without this the running window is a second, unmatched icon');
for (const script of ['dist:linux', 'dist:win', 'desktop:pack:linux', 'test:packaging']) {
  assert.ok(pkg.scripts[script], `package.json has no ${script} script`);
}
console.log('PASS: the builder config names Linux targets, an executable and its dependencies');

/* --------------------------------------------------------------------------
 * The native binary the packaged backend cannot run without
 * ----------------------------------------------------------------------- */

/*
 * Where better-sqlite3 keeps its compiled binary is a property of the version
 * installed, not a constant. v11 built `build/Release/better_sqlite3.node`;
 * from v12 a prebuilt `prebuilds/<platform>-<arch>.node` is downloaded and no
 * build directory is created at all. The packaging check used to name the first
 * path, so raising the dependency failed the build at its very last step, after
 * the whole Electron download and pack, over a file that was never going to be
 * there.
 *
 * This holds the check against the dependency actually installed, which costs
 * nothing and fails in a second rather than at the end of a ten-minute build.
 */
const { nativeBinaries } = require(path.join(root, 'tools/verify-desktop.cjs'));
const sqlite = path.join(root, 'node_modules', 'better-sqlite3');
if (fs.existsSync(sqlite)) {
  const found = nativeBinaries(sqlite);
  assert.ok(found.length, 'the installed better-sqlite3 has no .node binary the packaging check can find');
  assert.ok(found.some((file) => /linux-x64\.node$|better_sqlite3\.node$/.test(file)),
    'no binary this build could package for Linux x64');
  console.log(`PASS: the packaging check finds better-sqlite3's binary where this version keeps it`);
} else {
  console.log('SKIP: better-sqlite3 is not installed, so its layout cannot be checked');
}
assert.equal(nativeBinaries(path.join(root, 'node_modules', 'no-such-package-here')).length, 0,
  'a missing package must read as no binaries, not throw');

/* --------------------------------------------------------------------------
 * The files an Arch install is made of
 * ----------------------------------------------------------------------- */

const entry = read('packaging/linux/mediawatcher.desktop');
const fields = Object.fromEntries(entry.split(/\r?\n/)
  .filter((line) => line.includes('=') && !line.startsWith('#'))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
assert.equal(fields.Type, 'Application');
assert.equal(fields.Exec.split(' ')[0], builder.linux.executableName,
  'the desktop entry runs a name that /usr/bin does not have');
assert.equal(fields.Icon, 'mediawatcher');
assert.equal(fields.StartupWMClass, builder.linux.desktop.entry.StartupWMClass);
assert.match(fields.Categories, /AudioVideo/);

const service = read('packaging/linux/mediawatcher-server.service');
assert.match(service, /^ExecStart=\/opt\/mediawatcher\/resources\/runtime\/node /m,
  'the unit must run the Node that ships with the package');
assert.match(service, /^Environment=MW_DATA_DIR=/m, 'the unit and the app must share one library');
// The app defaults to userData/data, which is ~/.config/MediaWatcher/data on
// Linux. A unit pointed anywhere else is a second, silently separate library.
assert.match(service, /MW_DATA_DIR=%h\/\.config\/MediaWatcher\/data/);

const pkgbuild = read('packaging/arch/PKGBUILD');
assert.match(pkgbuild, /^pkgname=mediawatcher$/m);
assert.match(pkgbuild, new RegExp(`^pkgver=${pkg.version.replace(/\./g, '\\.')}$`, 'm'),
  'the PKGBUILD version has drifted from package.json');
/*
 * What the machine has to have.
 *
 * Electron is bundled, so these are the system libraries Chromium links
 * against. Getting one wrong is not a build failure — it is an application
 * that installs cleanly and then does nothing when its icon is clicked, with
 * the missing library named only in a terminal nobody ran it from. Each of
 * these was checked against Arch's package list, and libappindicator-gtk3 is
 * asserted absent because it no longer exists there under that name.
 */
const pkgbuildDepends = (pkgbuild.match(/^depends=\(([\s\S]*?)^\)$/m)?.[1] || '')
  .split('\n').map((line) => line.replace(/#.*$/, '').trim().replace(/^'|'$/g, ''))
  .filter(Boolean);
for (const need of ['ffmpeg', 'gtk3', 'nss', 'alsa-lib', 'libcups', 'mesa', 'at-spi2-core', 'ttf-font',
  // The tray is how the app runs with its window closed, which is its default.
  // An optional dependency is one pacman does not install.
  'libayatana-appindicator']) {
  assert.ok(pkgbuildDepends.includes(need), `Arch needs ${need} at runtime and the PKGBUILD omits it`);
}
assert.equal(pkgbuild.includes('libappindicator-gtk3'), false,
  'Arch has no libappindicator-gtk3; the tray library is libayatana-appindicator');
// Two packaging paths, one application: they cannot need different things.
assert.deepEqual([...builder.pacman.depends].sort(), [...pkgbuildDepends].sort(),
  'the PKGBUILD and the electron-builder pacman target disagree about dependencies');
// nodejs builds this and does not run it; the package carries its own copy.
assert.equal(pkgbuildDepends.some((each) => each.startsWith('nodejs')), false,
  'the packaged backend brings its own Node, so nothing should depend on the system one');
assert.match(pkgbuild, /makedepends=\(.*'nodejs>=20'.*\)/, 'building needs Node 20 or newer');
assert.match(pkgbuild, /chmod 4755 "\$pkgdir\/opt\/\$pkgname\/chrome-sandbox"/,
  'without a setuid sandbox helper Chromium either fails or runs unsandboxed');
assert.match(pkgbuild, /MW_LINUX_PACKAGE=pacman/,
  'the launcher is what tells the updates window who installed this');
/*
 * It packages the checkout it lives in, and it does that without a VCS source.
 *
 * A git source has three ways to fail before this compiles a line — a ref that
 * has to exist, a working copy makepkg has to create, and a `git rev-parse`
 * that returns nothing when git distrusts the directory's ownership, which
 * silently falls back to fetching a tag. Every one of them ends in "invalid
 * reference" about a tag that was never the point. So there is no source= to
 * resolve: prepare() exports the tree from a path it works out from its own
 * location.
 */
assert.match(pkgbuild, /^source=\(\)$/m, 'a VCS source is what kept failing; there must not be one');
assert.equal(/^source=\(["']?git\+/m.test(pkgbuild), false, 'no git source may come back');
assert.match(pkgbuild, /^prepare\(\) \{/m, 'the tree is exported by prepare()');
assert.match(pkgbuild, /cd "\$startdir\/\.\.\/\.\." /,
  'the repository root is found from this file\'s own location, not by asking git');
assert.match(pkgbuild, /git -C "\$repo" archive/, 'git archive leaves untracked and ignored files behind');
// git archive already excludes them, but the no-git fallback is a plain copy
// and the build tree must never carry a password or a key either way.
for (const secret of ['.env', 'config/admin-key']) {
  assert.ok(pkgbuild.includes(secret), `prepare() must exclude ${secret} from the build tree`);
}
assert.match(pkgbuild, /rm -f "\$srcdir\/\$_srcdir\/\.env"/,
  'whichever route was taken, the secrets are removed afterwards');
for (const file of ['packaging/linux/mediawatcher.desktop', 'packaging/linux/mediawatcher-server.service',
  'public/icons/icon-512.png', 'docs/linux.md', 'README.md']) {
  assert.ok(pkgbuild.includes(file), `the PKGBUILD installs ${file}, which must exist`);
  assert.ok(fs.existsSync(path.join(root, file)), `Missing packaged file: ${file}`);
}

const launcher = read('mediawatcher');
assert.match(launcher, /^#!\/usr\/bin\/env bash$/m);
assert.equal(Boolean(fs.statSync(path.join(root, 'mediawatcher')).mode & 0o111), true,
  'the launcher is not executable, so nobody can run it');
console.log('PASS: the desktop entry, the unit, the PKGBUILD and the launcher agree with each other');
