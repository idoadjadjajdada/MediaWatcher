const { repository } = require('./desktop/release.json');
const [owner, repo] = String(repository || '').split('/');
// One source of truth for the release location: the app checks this repository
// at runtime, and the build publishes latest.yml plus app-update.yml for it.
if (!owner || !repo) throw new Error('Set the GitHub repository in desktop/release.json before building.');

module.exports = {
  appId: 'com.mediawatcher.desktop',
  productName: 'MediaWatcher',
  directories: { app: '.desktop-build/shell', output: 'dist' },
  // The staged shell holds only electron-updater and its dependencies.
  files: ['desktop/**/*', 'public/**/*', 'package.json', 'node_modules/**/*'],
  asar: true,
  publish: [{ provider: 'github', owner, repo, releaseType: 'release' }],
  npmRebuild: false,
  afterPack: require('./tools/verify-desktop.cjs'),
  extraResources: [
    { from: '.desktop-build/backend', to: 'backend' },
    // electron-builder excludes nested node_modules during generic resource
    // copies. Copy the backend's production dependencies as their own root.
    { from: '.desktop-build/backend/node_modules', to: 'backend/node_modules', filter: ['**/*'] },
    { from: '.desktop-build/runtime', to: 'runtime' },
    { from: '.desktop-build/bin', to: 'bin' }
  ],
  win: {
    icon: 'public/icons/icon-512.png',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}'
  },
  nsis: {
    // A maintenance page when it is already installed; see build/installer.nsh.
    include: 'build/installer.nsh',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'MediaWatcher',
    deleteAppDataOnUninstall: false
  },
  /*
   * Two Linux artefacts, because they answer to different owners.
   *
   * The AppImage is one file that runs anywhere and is the only Linux format
   * electron-updater can replace in place, so it is what the app's own update
   * flow talks about. The pacman package is the one an Arch machine should
   * actually have installed: it lands in /opt with a desktop entry and icons,
   * pulls in FFmpeg as a dependency, and is updated by pacman rather than by
   * the app — which the updates window says rather than trying anyway.
   *
   * packaging/arch/PKGBUILD builds the same thing from source for anyone who
   * would rather not have electron-builder's fpm download in the middle of it.
   */
  linux: {
    // A single PNG of at least 256px; electron-builder derives the size set
    // Linux desktops ask for, so there is no generated icon folder to commit.
    icon: 'public/icons/icon-512.png',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'pacman', arch: ['x64'] },
      { target: 'tar.gz', arch: ['x64'] }
    ],
    artifactName: '${productName}-${version}-${arch}.${ext}',
    // Named here rather than left to a default, because /usr/bin, the desktop
    // entry's Exec line and the PKGBUILD all have to say the same word.
    executableName: 'mediawatcher',
    category: 'AudioVideo;Video;Player;Network',
    synopsis: 'Self-hosted media library with a built-in player',
    description: 'MediaWatcher scans your movies and TV shows, enriches them with TMDB metadata, '
      + 'fetches new releases through a debrid service and plays them back with resume, subtitles '
      + 'and next-episode autoplay.',
    maintainer: 'MediaWatcher <noreply@example.invalid>',
    desktop: {
      entry: {
        Name: 'MediaWatcher',
        Comment: 'Self-hosted media library with a built-in player',
        Categories: 'AudioVideo;Video;Player;Network;',
        Keywords: 'media;video;movies;tv;library;player;',
        // Without this the window is a second, unmatched entry in the dock.
        StartupWMClass: 'MediaWatcher',
        StartupNotify: 'true'
      }
    }
  },
  pacman: {
    // The same runtime dependencies packaging/arch/PKGBUILD declares, and
    // packaging.test.mjs fails if the two lists ever disagree: two packaging
    // paths that install the same application must need the same things.
    depends: ['ffmpeg', 'gtk3', 'nss', 'alsa-lib', 'libcups', 'mesa', 'libdrm',
      'libxtst', 'libxss', 'libnotify', 'at-spi2-core', 'ttf-font',
      'libayatana-appindicator'],
    // Arch calls it x86_64; the artifact name should too.
    artifactName: '${productName}-${version}-x86_64.${ext}'
  }
};
