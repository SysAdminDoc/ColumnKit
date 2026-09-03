// Writes dist/SHA256SUMS.txt for the packaged artifacts, and copies install.cmd
// in beside them so a release folder is self-contained.
//
// The release is unsigned, so this file is the only way a downloader can tell
// they got what was built.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
const artifacts = fs.readdirSync(dist).filter(name => name.endsWith('.vsix')).sort();

if (artifacts.length === 0) {
    console.error('no .vsix in dist/; run vsce package first');
    process.exit(1);
}

const lines = artifacts.map(name => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex');
    return `${hash}  ${name}`;
});

fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
fs.copyFileSync(path.join(__dirname, 'install.cmd'), path.join(dist, 'install.cmd'));

console.log(lines.join('\n'));
console.log(`wrote dist/SHA256SUMS.txt and copied install.cmd (${artifacts.length} artifact(s))`);
