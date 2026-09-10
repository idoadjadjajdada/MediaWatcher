/**
 * What differs between the machines this app is built for.
 *
 * Three separate programs need to agree on these answers — the build that
 * stages the payload, the check that runs against the packaged directory, and
 * the shell that launches the backend at runtime — and they disagreed by
 * copying string literals at each other. A staged `node.exe` and a runtime
 * looking for `node` is not a bug anyone finds by reading either file.
 *
 * So the differences live here, named, and each caller asks rather than knows.
 * Windows is unchanged by any of it; Linux is the platform this was opened up
 * for, and it is opened up on the one point that actually varies: what the
 * executables are called, which icon a window can use, and who is allowed to
 * replace the application.
 */
const path = require('node:path');

/**
 * The targets a payload can be staged for.
 *
 * `selfUpdating` is about who owns the installed files. The Windows installer
 * and a Linux AppImage are single artefacts the app can replace on its own; a
 * distribution package belongs to the package manager, and an app that
 * overwrites one behind pacman's back leaves a system that lies about what is
 * installed.
 */
const TARGETS = {
  win32: {
    label: 'Windows',
    arch: ['x64'],
    exeSuffix: '.exe',
    // A .ico carries every size Windows asks for, including the tray's.
    windowIcon: 'icons/app.ico',
    trayIcon: 'icons/app.ico',
    sharedLibrary: /\.dll$/i
  },
  linux: {
    label: 'Linux',
    arch: ['x64', 'arm64'],
    exeSuffix: '',
    // Linux takes a PNG. The tray gets a small one because several panels
    // scale whatever they are handed, and a 512px source scaled to 22px by a
    // panel looks worse than a 192px one does.
    windowIcon: 'icons/icon-512.png',
    trayIcon: 'icons/icon-192.png',
    sharedLibrary: /\.so(\.\d+)*$/
  }
};

/** The staging target for a platform/arch pair, or null where there is none. */
function target(platform = process.platform, arch = process.arch) {
  const found = TARGETS[platform];
  if (!found || !found.arch.includes(arch)) return null;
  return { platform, arch, ...found };
}

/** The same, but a build that cannot produce anything should say so loudly. */
function requireTarget(platform = process.platform, arch = process.arch) {
  const found = target(platform, arch);
  if (found) return found;
  const supported = Object.entries(TARGETS)
    .flatMap(([name, spec]) => spec.arch.map((each) => `${name}-${each}`));
  throw new Error(`No desktop build for ${platform}-${arch}. Supported: ${supported.join(', ')}.`);
}

/** `ffmpeg` or `ffmpeg.exe`, for whichever platform is being talked about. */
function executableName(name, platform = process.platform) {
  return `${name}${TARGETS[platform]?.exeSuffix ?? ''}`;
}

/** The Node the backend is forked with, inside a packaged application. */
function bundledNode(resourcesPath, platform = process.platform) {
  return path.join(resourcesPath, 'runtime', executableName('node', platform));
}

/**
 * Whether this running copy may replace itself.
 *
 * On Windows the installer always can. On Linux only an AppImage can: it is one
 * file, and electron-updater knows how to swap it. Anything else — a pacman
 * package, a tarball someone unpacked, a `--dir` build — is owned by whatever
 * put it there, so the app checks for releases and then says who to ask.
 */
function selfUpdating({ platform = process.platform, packaged = true, env = process.env } = {}) {
  if (!packaged) return false;
  if (platform === 'win32') return true;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  return false;
}

/** What to tell someone whose copy is not allowed to update itself. */
function updateHint({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return 'This copy of MediaWatcher is updated by whatever installed it.';
  if (env.MW_LINUX_PACKAGE === 'pacman' || env.MW_LINUX_PACKAGE === 'arch') {
    return 'This copy was installed by pacman. Update it with your package manager — for example '
      + '“pacman -Syu mediawatcher”, or rebuild the PKGBUILD in packaging/arch.';
  }
  return 'This copy was installed by your package manager or unpacked by hand, so MediaWatcher '
    + 'will not replace its own files. Update it the way it was installed, or use the AppImage '
    + 'to get in-app updates.';
}

/**
 * The electron-updater class for a platform, given lazily so that neither the
 * tests nor a Windows build ever loads the Linux one, or the reverse.
 */
function makeUpdater(options, platform = process.platform) {
  const updater = require('electron-updater');
  if (platform === 'linux') return new updater.AppImageUpdater(options);
  return new updater.NsisUpdater(options);
}

/** The modes the window's GPU use can be put into. */
const GPU_MODES = ['auto', 'off', 'software'];

/**
 * What to ask Chromium for, given a mode and a platform.
 *
 * Windows needs none of it: video decodes on the GPU there by default and the
 * compositor is on a path everybody tests. Linux is the opposite on both
 * counts — accelerated decode is off unless asked for by name, the driver may
 * be on a blocklist written years ago, and a window running through XWayland in
 * a Wayland session has its frames paced by two compositors that disagree,
 * which is the shape of a stutter that comes and goes on content the machine is
 * more than fast enough to play.
 *
 * Returned as data rather than applied here so the decision can be tested
 * without a display, a GPU, or Electron.
 *
 * @returns {{ disableHardwareAcceleration: boolean, switches: [string, string?][] }}
 */
function gpuSwitches({ mode = 'auto', platform = process.platform } = {}) {
  const chosen = GPU_MODES.includes(mode) ? mode : 'auto';
  // Not a fallback but an instruction: some drivers composite worse than the
  // CPU does, and a smooth software window beats a stuttering accelerated one.
  if (chosen === 'software') return { disableHardwareAcceleration: true, switches: [] };
  // 'off' is what every version before this did, on every platform.
  if (chosen === 'off' || platform !== 'linux') return { disableHardwareAcceleration: false, switches: [] };
  return {
    disableHardwareAcceleration: false,
    switches: [
      // Chromium ignores feature names it does not know, which is what makes
      // naming several safe: these are one capability as it has been spelled
      // across Chromium versions, and the build takes whichever it has.
      ['enable-features', [
        'AcceleratedVideoDecodeLinuxGL',
        'AcceleratedVideoDecodeLinuxZeroCopyGL',
        'VaapiVideoDecoder',
        'VaapiVideoDecodeLinuxGL'
      ].join(',')],
      // Conservative and largely historical; a driver good enough to run this
      // window is good enough to decode into it.
      ['ignore-gpu-blocklist'],
      // Wayland natively where there is a Wayland session, rather than through
      // XWayland. 'auto' is Chromium's own detection, so an X11 session is
      // unaffected — and this is the half most likely to be the stutter,
      // because XWayland pacing errors show up on content of any size.
      ['ozone-platform-hint', 'auto']
    ]
  };
}

module.exports = {
  TARGETS, target, requireTarget, executableName, bundledNode,
  selfUpdating, updateHint, makeUpdater, GPU_MODES, gpuSwitches
};
