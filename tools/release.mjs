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

const released = (() => {
  try {
    run('gh', ['release', 'view', tag, '--repo', repository], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
})();
if (released) throw new Error(`${tag} is already released. Raise the version in package.json.`);

console.log(`Building ${tag} for ${repository}…`);
run('npm', ['run', 'dist'], { stdio: 'inherit', shell: process.platform === 'win32' });

// electron-builder writes these from the publish configuration; without
// latest.yml the release exists and no installed copy ever sees it.
const dist = path.join(root, 'dist');
const installer = `MediaWatcher-Setup-${version}-x64.exe`;
const assets = [installer, `${installer}.blockmap`, 'latest.yml'];
for (const asset of assets) {
  const file = path.join(dist, asset);
  if (!fs.existsSync(file)) throw new Error(`The build produced no ${asset}.`);
  if (fs.statSync(file).size === 0) throw new Error(`${asset} is empty.`);
}
if (!read('dist/latest.yml').includes(installer)) {
  throw new Error('latest.yml does not name this installer; the build and the version disagree.');
}

if (dryRun) {
  console.log(`Built. ${assets.join(', ')} are in dist/. Nothing was published.`);
  process.exit(0);
}

const notesFile = path.join(dist, `notes-${version}.md`);
fs.writeFileSync(notesFile, `${notes}\n`);
run('gh', ['release', 'create', tag,
  ...assets.map((asset) => path.join(dist, asset)),
  '--repo', repository,
  '--title', `MediaWatcher ${version}`,
  '--notes-file', notesFile,
  '--target', run('git', ['rev-parse', 'HEAD']).trim()
], { stdio: 'inherit' });

console.log(`\nPublished ${tag}: https://github.com/${repository}/releases/tag/${tag}`);
console.log('Installed copies will offer it at their next check.');
