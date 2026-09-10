/**
 * Publish a release: the installer, the files the updater needs, and the notes
 * for this version.
 *
 * The app finds updates by reading `latest.yml` out of a GitHub release, so a
 * release missing it is invisible — and one carrying an installer nobody wrote
 * notes for is worse than none at all, because the update prompt asks people to
 * close what they are watching without saying what for. Both are checked here
 * rather than remembered.
 *
 * Run: node tools/release.mjs        (add --dry-run to build and stop)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });

const { version } = JSON.parse(read('package.json'));
const tag = `v${version}`;
const { repository } = JSON.parse(read('desktop/release.json'));
if (!repository) throw new Error('Set the GitHub repository in desktop/release.json.');

/* The tag has to mean something: it names the commit an installer was built
   from, and someone reading it later has only the tag to go on. */
if (run('git', ['status', '--porcelain']).trim()) {
  throw new Error('Commit or stash your changes first; a release names one commit.');
}
if (run('git', ['rev-list', '--count', 'origin/main..HEAD']).trim() !== '0') {
  throw new Error('Push to origin/main first, or the tag will point at a commit nobody else has.');
}

// The notes are this version's section of the changelog, verbatim.
const changelog = read('CHANGELOG.md');
const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$`, 'm');
const start = changelog.search(heading);
if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section. Write the notes first.`);
const rest = changelog.slice(start).split(/\r?\n/).slice(1);
const end = rest.findIndex((line) => /^## /.test(line));
const notes = rest.slice(0, end < 0 ? rest.length : end).join('\n').trim();
if (notes.length < 40) throw new Error(`The notes for ${version} are too thin to publish.`);

/*
 * One version, one release, more than one platform.
 *
 * The Windows installer and the Linux AppImage are built on the machines that
 * can build them, which means the second one arrives at a tag that already
 * exists. Refusing there would leave Linux permanently unable to publish any
 * version Windows got to first. So an existing release is joined rather than
 * replaced — and re-publishing the same platform into it is still refused,
 * because that is the case where somebody meant to raise the version.
 */
const existingAssets = (() => {
  try {
    const view = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'assets'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(view).assets.map((asset) => asset.name);
  } catch { return null; }
})();

console.log(`Building ${tag} for ${repository} on ${process.platform}…`);
run('npm', ['run', 'dist'], { stdio: 'inherit', shell: process.platform === 'win32' });

/*
 * What a release has to carry, per platform.
 *
 * electron-updater does not read the release's file list; it reads one YAML
 * file whose name is fixed per platform, and follows it to an artefact by name.
 * So the manifest and the thing it names are equally mandatory, and a release
 * whose manifest names a different build sends every installed copy after a
 * file that is not there. Linux publishes the AppImage because it is the only
 * Linux format the updater can replace in place — the pacman package and the
 * tarball are attached as well, and are updated by whatever installed them.
 */
const ARTEFACTS = {
  win32: () => {
    const installer = `MediaWatcher-Setup-${version}-x64.exe`;
    return { manifest: 'latest.yml', updated: installer, required: [installer, `${installer}.blockmap`] };
  },
  linux: () => {
    const appImage = `MediaWatcher-${version}-x86_64.AppImage`;
    return {
      manifest: 'latest-linux.yml',
      updated: appImage,
      required: [appImage],
      // Nice to have and published when present, but a missing one is not a
      // reason to withhold a release that the updater can already act on.
      optional: [`MediaWatcher-${version}-x86_64.pkg.tar.zst`, `MediaWatcher-${version}-x64.tar.gz`]
    };
  }
};
const shape = ARTEFACTS[process.platform];
if (!shape) throw new Error(`Releases are built on Windows or Linux, not ${process.platform}.`);
const { manifest, updated, required, optional = [] } = shape();

const dist = path.join(root, 'dist');
const present = (asset) => {
  const file = path.join(dist, asset);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
};
const assets = [...required, manifest];
for (const asset of assets) {
  const file = path.join(dist, asset);
  if (!fs.existsSync(file)) throw new Error(`The build produced no ${asset}.`);
  if (fs.statSync(file).size === 0) throw new Error(`${asset} is empty.`);
}
assets.push(...optional.filter(present));
for (const asset of optional.filter((each) => !present(each))) {
  console.log(`Note: ${asset} was not built, so it is not part of this release.`);
}
if (!read(`dist/${manifest}`).includes(updated)) {
  throw new Error(`${manifest} does not name ${updated}; the build and the version disagree.`);
}
if (existingAssets?.includes(manifest)) {
  throw new Error(`${tag} already carries ${manifest}, so this platform is published. `
    + 'Raise the version in package.json.');
}

if (dryRun) {
  console.log(`Built. ${assets.join(', ')} are in dist/. Nothing was published.`);
  process.exit(0);
}

const files = assets.map((asset) => path.join(dist, asset));
if (existingAssets) {
  console.log(`${tag} exists; adding this platform's build to it.`);
  run('gh', ['release', 'upload', tag, ...files, '--repo', repository], { stdio: 'inherit' });
} else {
  const notesFile = path.join(dist, `notes-${version}.md`);
  fs.writeFileSync(notesFile, `${notes}\n`);
  run('gh', ['release', 'create', tag, ...files,
    '--repo', repository,
    '--title', `MediaWatcher ${version}`,
    '--notes-file', notesFile,
    '--target', run('git', ['rev-parse', 'HEAD']).trim()
  ], { stdio: 'inherit' });
}

console.log(`\nPublished ${tag}: https://github.com/${repository}/releases/tag/${tag}`);
console.log('Installed copies will offer it at their next check.');
