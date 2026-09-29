// Pulls one version's section out of CHANGELOG.md, for the GitHub release.
//
// The commit history here is not usable for this: the repository is updated by
// uploading files through the web interface, so almost every commit is called
// "Add files via upload". Generated notes would say nothing. The changelog is
// written by hand and is the only honest source.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (version === undefined || version === '') {
  console.error('usage: release-notes.mjs <version>');
  process.exit(2);
}

const changelog = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((line) => line.trim() === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}. Add one before releasing.`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## '));
const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();

process.stdout.write(`${body}\n\n---\n\nInstall or upgrade:\n\n\`\`\`sh\nnpx deepblame@${version} init\n\`\`\`\n`);
