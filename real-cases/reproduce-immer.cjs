#!/usr/bin/env node
// Reproduces the Immer 10.1.1 real-world case end to end from public sources only:
// npm tarball download, public GitHub clone, then a read-only sourcemap-lineage run.
//
// NOT part of `node --test` (see regression.test.cjs): this script needs network
// access and takes noticeably longer than the synthetic suite, so it is run
// explicitly: `node real-cases/reproduce-immer.cjs [--repo <existing clone>]`
//
// No credentials, no npm/git write operations, no artifact modification.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const PACKAGE = 'immer';
const VERSION = '10.1.1';
const TARBALL_URL = `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${VERSION}.tgz`;
const REPO_URL = 'https://github.com/immerjs/immer.git';
const ARTIFACT_REL = 'package/dist/immer.mjs';
// Independently obtained from the published tarball and npm registry metadata; not
// passed to sourcemap-lineage.cjs, used only to validate this reproduction script itself.
const EXPECTED = {
  artifactSha256: '251bf957417907396d567c1f85ada354075cc9b10f57b25d973de334ad2fc49a',
  mapSha256: '296cf64d343e4480d574b0dc1915c7194270ff93b4aa3d4409212b445af07410',
  gitHead: 'e2d222bd4fb26abded04075c936290715e9ee335',
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
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'build-paternity-real-case-repro' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const repoArgIdx = argv.indexOf('--repo');
  const workDir = argv.includes('--work-dir') ? path.resolve(argv[argv.indexOf('--work-dir') + 1])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'build-paternity-immer-'));
  fs.mkdirSync(workDir, { recursive: true });
  console.log(`Work directory: ${workDir}`);

  // 1. Download and verify the published artifact + its ground-truth gitHead, from the registry only.
  const tgzPath = path.join(workDir, 'immer.tgz');
  if (!fs.existsSync(tgzPath)) { console.log(`Downloading ${TARBALL_URL} ...`); await download(TARBALL_URL, tgzPath); }
  const extractDir = path.join(workDir, 'immer');
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
    // --force-local: without it, bsdtar/Windows tar can misparse a "C:\..." path as a
    // remote host:path spec and fail with "Cannot connect to C: resolve failed".
    execFileSync('tar', ['--force-local', '-xzf', posix(tgzPath), '-C', posix(extractDir)]);
  }
  const artifactPath = path.join(extractDir, ARTIFACT_REL);
  const mapPath = artifactPath + '.map';
  const artifactHash = sha256(fs.readFileSync(artifactPath));
  const mapHash = sha256(fs.readFileSync(mapPath));
  console.log(`Artifact SHA-256: ${artifactHash}`);
  console.log(`Map SHA-256:      ${mapHash}`);
  if (artifactHash !== EXPECTED.artifactSha256) throw new Error('artifact hash mismatch vs recorded evidence');
  if (mapHash !== EXPECTED.mapSha256) throw new Error('map hash mismatch vs recorded evidence');

  const pkgMeta = await fetchJson(`https://registry.npmjs.org/${PACKAGE}`);
  const versionMeta = pkgMeta.versions[VERSION];
  console.log(`npm registry gitHead for ${PACKAGE}@${VERSION}: ${versionMeta.gitHead}`);
  console.log(`npm registry publish time: ${pkgMeta.time[VERSION]}`);
  if (versionMeta.gitHead !== EXPECTED.gitHead) throw new Error('npm registry gitHead does not match recorded ground-truth metadata');

  // 2. Clone the public repository (read-only; no push, no credentials).
  const repoDir = repoArgIdx >= 0 ? path.resolve(argv[repoArgIdx + 1]) : path.join(workDir, 'immer-repo');
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log(`Cloning ${REPO_URL} ...`);
    execFileSync('git', ['clone', '-q', REPO_URL, posix(repoDir)], { stdio: 'inherit' });
  }
  const commitType = execFileSync('git', ['-C', repoDir, 'cat-file', '-t', EXPECTED.gitHead], { encoding: 'utf8' }).trim();
  if (commitType !== 'commit') throw new Error(`expected commit ${EXPECTED.gitHead} not found in cloned history`);

  // 3. Run sourcemap-lineage, read-only. The expected commit above is ground-truth
  // metadata for validating THIS script, and is never passed to the CLI.
  const cli = path.join(__dirname, '..', 'sourcemap-lineage.cjs');
  console.log('\nRunning sourcemap-lineage (read-only) ...\n');
  const stdout = execFileSync(process.execPath, [cli, artifactPath, '--repo', repoDir, '--max-commits', '10000', '--lines', '8'], { encoding: 'utf8' });
  console.log(stdout);

  // 4. Validate the tool's own output shape, and separately report whether the
  // ground-truth commit is inside the reported candidate group (evaluation only).
  const checks = [
    [/sourceGit: EXACT \(12\/12/, 'sourceGit EXACT 12/12'],
    [/Classification: AMBIGUOUS/, 'Classification AMBIGUOUS'],
    [/Evidence level: STRONG_CANDIDATE/, 'Evidence level STRONG_CANDIDATE'],
    [/dirtyBuild: NOT_INDICATED/, 'dirtyBuild NOT_INDICATED'],
    [/Artifact-level attribution: NOT_ESTABLISHED/, 'artifact attribution NOT_ESTABLISHED'],
    [/commit: CANDIDATE_GROUP \(2 source-identical/, 'commit CANDIDATE_GROUP of 2'],
  ];
  let ok = true;
  for (const [re, label] of checks) {
    const pass = re.test(stdout);
    console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}`);
    ok = ok && pass;
  }
  const groupMatch = /commit ([0-9a-f]{7}).*\n\s*\+ 1 other commit\(s\).*: ([0-9a-f]{7})/.exec(stdout);
  const short = EXPECTED.gitHead.slice(0, 7);
  const groupContainsExpected = groupMatch && (groupMatch[1] === short || groupMatch[2] === short);
  console.log(`${groupContainsExpected ? 'PASS' : 'FAIL'}: reported candidate group includes the ground-truth commit ${short} (evaluation-only comparison, not something the tool itself asserts)`);
  ok = ok && groupContainsExpected;

  if (!ok) { console.error('\nReproduction did NOT match the recorded real-case evidence.'); process.exit(1); }
  console.log('\nReproduction matches the recorded Immer 10.1.1 real-case evidence.');
}

main().catch((err) => { console.error(err); process.exit(1); });
