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
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'MediaWatcher',
    deleteAppDataOnUninstall: false
  }
};
