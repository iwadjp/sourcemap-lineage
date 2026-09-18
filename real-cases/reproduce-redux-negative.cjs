#!/usr/bin/env node
// Reproduces the Redux 5.0.1 negative/abstention case: a real published artifact
// whose sourcesContent does NOT match any inspected commit, so sourcemap-lineage must
// abstain cleanly (UNKNOWN) instead of printing a misleading best-guess candidate.
//
// Public sources only: npm tarball + public GitHub clone. No credentials.
// Not part of `node --test`; run explicitly: node real-cases/reproduce-redux-negative.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const TARBALL_URL = 'https://registry.npmjs.org/redux/-/redux-5.0.1.tgz';
const REPO_URL = 'https://github.com/reduxjs/redux.git';
const ARTIFACT_REL = 'package/dist/redux.browser.mjs';
const EXPECTED = {
  artifactSha256: '74d4f330fcf7a7fecb7a83cc4b4b65d685cf99f189bd4eecf50e07ee5897e58c',
  mapSha256: '567680d887ce443b4675e79df85e5333111560ae21c1b3ea1ccd40a62a80d03d',
};

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
// Windows tar (bsdtar) mishandles backslash-containing -C/-f arguments (backslash is
// its own escape char); forward slashes work everywhere tar/git run on.
const posix = (p) => p.replace(/\\/g, '/');
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'user-agent': 'build-paternity-real-case-repro' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.rmSync(dest, { force: true });
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) { reject(new Error(`GET ${url} -> ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const repoArgIdx = argv.indexOf('--repo');
  const workDir = argv.includes('--work-dir') ? path.resolve(argv[argv.indexOf('--work-dir') + 1])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'build-paternity-redux-'));
  fs.mkdirSync(workDir, { recursive: true });
  console.log(`Work directory: ${workDir}`);

  const tgzPath = path.join(workDir, 'redux.tgz');
  if (!fs.existsSync(tgzPath)) { console.log(`Downloading ${TARBALL_URL} ...`); await download(TARBALL_URL, tgzPath); }
  const extractDir = path.join(workDir, 'redux');
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['--force-local', '-xzf', posix(tgzPath), '-C', posix(extractDir)]);
  }
  const artifactPath = path.join(extractDir, ARTIFACT_REL);
  const artifactHash = sha256(fs.readFileSync(artifactPath));
  const mapHash = sha256(fs.readFileSync(artifactPath + '.map'));
  console.log(`Artifact SHA-256: ${artifactHash}`);
  console.log(`Map SHA-256:      ${mapHash}`);
  if (artifactHash !== EXPECTED.artifactSha256) throw new Error('artifact hash mismatch vs recorded evidence');
  if (mapHash !== EXPECTED.mapSha256) throw new Error('map hash mismatch vs recorded evidence');

  const repoDir = repoArgIdx >= 0 ? path.resolve(argv[repoArgIdx + 1]) : path.join(workDir, 'redux-repo');
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log(`Cloning ${REPO_URL} (full history; this can take a few minutes) ...`);
    execFileSync('git', ['clone', '-q', REPO_URL, posix(repoDir)], { stdio: 'inherit' });
  }

  const cli = path.join(__dirname, '..', 'sourcemap-lineage.cjs');
  console.log('\nRunning sourcemap-lineage (read-only) ...\n');
  const stdout = execFileSync(process.execPath, [cli, artifactPath, '--repo', repoDir, '--max-commits', '10000', '--lines', '8'], { encoding: 'utf8' });
  console.log(stdout);

  const checks = [
    [/sourceGit: UNKNOWN \(GIT_SOURCE_NO_EXACT_MATCH\)/, 'sourceGit UNKNOWN (no exact match)'],
    [/Classification: UNKNOWN/, 'Classification UNKNOWN'],
    [/Evidence level: UNKNOWN/, 'Evidence level UNKNOWN'],
    [/commit: NONE/, 'commit NONE'],
    [/dirtyBuild: UNKNOWN/, 'dirtyBuild UNKNOWN'],
    [/0 exact\/EOL matches/, 'diagnostic count confirms 0 exact/EOL matches'],
    [/Artifact-level attribution: NOT_ESTABLISHED/, 'artifact attribution NOT_ESTABLISHED'],
  ];
  // Negative case: the tool must NOT print a best-guess candidate or source diff here.
  const mustNotAppear = [
    [/Best source-state candidate/, 'no best-candidate line printed'],
    [/Recovered-source differences vs candidate/, 'no source-diff section printed'],
  ];
  let ok = true;
  for (const [re, label] of checks) { const pass = re.test(stdout); console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}`); ok = ok && pass; }
  for (const [re, label] of mustNotAppear) { const pass = !re.test(stdout); console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}`); ok = ok && pass; }

  if (!ok) { console.error('\nReproduction did NOT match the recorded negative-case evidence.'); process.exit(1); }
  console.log('\nReproduction matches the recorded Redux 5.0.1 negative/abstention case.');
}

main().catch((err) => { console.error(err); process.exit(1); });
