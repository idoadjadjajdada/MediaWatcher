module.exports = {
  appId: 'com.mediawatcher.desktop',
  productName: 'MediaWatcher',
  directories: { app: '.desktop-build/shell', output: 'dist' },
  files: ['desktop/**/*', 'public/**/*', 'package.json', '!node_modules/**/*'],
  asar: true,
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
