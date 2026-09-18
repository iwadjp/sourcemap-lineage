#!/usr/bin/env node
// sourcemap-lineage: infer which git source state produced a JS artifact, using only the artifact's
// sourcemap (sourcesContent) and git history. Read-only: runs `git log`, `git ls-tree`, `git cat-file` only.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { inspectMap } = require('./map-evidence.cjs');

const argv = process.argv.slice(2);
let artifact = null, repo = null, maxCommits = 2000, showLines = 12;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repo') repo = argv[++i];
  else if (argv[i] === '--max-commits') maxCommits = +argv[++i];
  else if (argv[i] === '--lines') showLines = +argv[++i];
  else artifact = argv[i];
}
if (!artifact) {
  console.error('usage: node sourcemap-lineage.cjs <artifact.js> [--repo <git repo>] [--max-commits n]');
  process.exit(1);
}
artifact = path.resolve(artifact);
if (!repo) {
  for (let d = path.dirname(artifact); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { repo = d; break; }
    if (path.dirname(d) === d) break;
  }
}
if (!repo) { console.error('no git repo found above the artifact; pass --repo'); process.exit(1); }
repo = path.resolve(repo);

const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const gitBuf = (a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 28 });
const blobHash = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const short = (h) => h.slice(0, 7);
const out = [];
const say = (s = '') => out.push(s);
const warnings = [];

// ---------- 1. artifact + sourcemap trust ----------
const artBuf = fs.readFileSync(artifact);
const artText = artBuf.toString('utf8');
const artStat = fs.statSync(artifact);
const urlMatches = [...artText.matchAll(/[#@]\s*sourceMappingURL=(\S+)/g)];
let mapText = null, mapPath = null, mapLink = null;
if (urlMatches.length) {
  const url = urlMatches[urlMatches.length - 1][1];
  if (url.startsWith('data:')) {
    mapText = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8');
    mapLink = 'inline data: URL in artifact';
  } else {
    mapPath = path.resolve(path.dirname(artifact), decodeURIComponent(url));
    mapLink = `sourceMappingURL=${url}`;
    if (!fs.existsSync(mapPath)) { warnings.push(`sourceMappingURL points to missing file ${url}`); mapPath = null; }
  }
} else if (fs.existsSync(artifact + '.map')) {
  mapPath = artifact + '.map';
  mapLink = 'NO sourceMappingURL; adjacent .map chosen by filename only (weak link)';
  warnings.push('artifact has no sourceMappingURL comment; map association is by filename only');
}
if (mapPath) mapText = fs.readFileSync(mapPath, 'utf8');

say('Artifact:');
say(`  ${path.basename(artifact)}  sha256=${crypto.createHash('sha256').update(artBuf).digest('hex').slice(0, 16)}...  ${artBuf.length} bytes`);
if (!mapText) {
  say('  no sourcemap found');
  say('artifactMap: UNKNOWN');
  say('sourceGit: UNKNOWN');
  say('commit: NONE');
  say('dirtyBuild: UNKNOWN');
  say('');
  say('Classification: UNKNOWN (no source evidence; minified-only artifacts are out of scope)');
  console.log(out.join('\n'));
  process.exit(0);
}
const map = JSON.parse(mapText);
say(`  map: ${mapPath ? path.basename(mapPath) : '(inline)'}  via ${mapLink}`);
if (map.file && path.basename(map.file) !== path.basename(artifact)) warnings.push(`map "file" field (${map.file}) does not match artifact name`);
if (mapPath) {
  const ms = fs.statSync(mapPath);
  if (Math.abs(ms.mtimeMs - artStat.mtimeMs) > 60000) warnings.push(`map and artifact mtimes differ by ${Math.round(Math.abs(ms.mtimeMs - artStat.mtimeMs) / 1000)}s (metadata only; compatibility not determined by timestamps)`);
}
const contents = map.sourcesContent || [];
// Names and string survival are not validity gates. Keep map compatibility apart
// from the recovered source's relationship to Git.
const artifactMap = inspectMap(artText, map, urlMatches.length > 0 &&
  (!map.file || path.basename(map.file) === path.basename(artifact)));
say('');
say(`artifactMap: ${artifactMap.status}`);
for (const reason of artifactMap.reasons) say(`  ${reason}`);
say(`  coordinates: ${artifactMap.coordinateErrors} out-of-range/order errors; ${artifactMap.malformedSegments} malformed segments`);
if (artifactMap.comparable) say(`  identifier retention (diagnostic, NOT map validity): ${artifactMap.unchangedNames}/${artifactMap.comparable} (${(100 * artifactMap.unchangedNames / artifactMap.comparable).toFixed(2)}%)`);
say(`  possible renames via names[]: ${artifactMap.possibleRenames}; short generated identifiers: ${artifactMap.shortGeneratedNames} (neither proves compatibility)`);
say(`  mapped whole-line context anchors: ${artifactMap.contextAnchors} across ${artifactMap.anchorSources} sources`);

// ---------- 2. git history index ----------
const commits = git(['log', '--all', '--topo-order', `--max-count=${maxCommits}`, '--format=%H%x09%ct%x09%s'])
  .trim().split('\n').filter(Boolean).map((l) => { const [h, t, ...s] = l.split('\t'); return { h, t: +t, s: s.join('\t') }; });
const trees = new Map();
const allPaths = new Set();
const blobWhere = new Map(); // blob -> [{path, commit}] (first occurrence per path, newest-first)
for (const c of commits) {
  const tree = new Map();
  for (const line of git(['ls-tree', '-r', '--full-tree', c.h]).split('\n')) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m) continue;
    tree.set(m[2], m[1]);
    allPaths.add(m[2]);
    if (!blobWhere.has(m[1])) blobWhere.set(m[1], []);
    const w = blobWhere.get(m[1]);
    if (!w.some((x) => x.path === m[2])) w.push({ path: m[2], commit: c });
  }
  trees.set(c.h, tree);
}

// ---------- 3. recovered sources -> repo paths ----------
const sources = (map.sources || []).map((raw, i) => {
  const content = typeof contents[i] === 'string' ? contents[i] : null;
  const segs = raw.replace(/^[a-z]+:\/\/[^/]*\//i, '').split(/[\\/]/).filter((x) => x && x !== '.' && x !== '..');
  let repoPath = null;
  for (let k = 0; k < segs.length && !repoPath; k++) if (allPaths.has(segs.slice(k).join('/'))) repoPath = segs.slice(k).join('/');
  const s = { raw, content, repoPath, kind: null };
  if (content === null) { s.kind = 'NO_CONTENT'; return s; }
  const lf = content.replace(/\r\n/g, '\n');
  s.hash = blobHash(Buffer.from(content, 'utf8'));
  s.variants = new Set([s.hash, blobHash(Buffer.from(lf, 'utf8')), blobHash(Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8'))]);
  if (segs.includes('node_modules')) s.kind = 'EXTERNAL';
  else if (repoPath) s.kind = 'TRACKED_PATH';
  else if (blobWhere.has(s.hash)) { s.kind = 'CONTENT_AT_OTHER_PATH'; s.repoPath = blobWhere.get(s.hash)[0].path; }
  else s.kind = 'NOT_IN_HISTORY';
  return s;
});
const tracked = sources.filter((s) => s.kind === 'TRACKED_PATH' || s.kind === 'CONTENT_AT_OTHER_PATH');
const counts = {};
for (const s of sources) counts[s.kind] = (counts[s.kind] || 0) + 1;

say('');
say('Source evidence:');
say(`  ${sources.length} sources in map, ${tracked.length} matched to repo paths` +
  Object.entries(counts).filter(([k]) => k !== 'TRACKED_PATH').map(([k, v]) => `, ${v} ${k}`).join(''));
if (tracked.length === 0) {
  say('sourceGit: UNKNOWN');
  say('commit: NONE');
  say('dirtyBuild: UNKNOWN');
  say('');
  say('Classification: UNKNOWN (no recovered source maps onto this repository)');
  flush();
}

// ---------- 4. score commits, grouped by identical blobs for the recovered paths ----------
const groups = new Map();
for (const c of commits) {
  const tree = trees.get(c.h);
  const sig = tracked.map((s) => tree.get(s.repoPath) || '-').join(',');
  if (!groups.has(sig)) {
    let exact = 0, eol = 0, diff = 0, missing = 0;
    for (const s of tracked) {
      const b = tree.get(s.repoPath);
      if (!b) missing++;
      else if (b === s.hash) exact++;
      else if (s.variants.has(b)) eol++;
      else diff++;
    }
    groups.set(sig, { commits: [], exact, eol, diff, missing, tree });
  }
  groups.get(sig).commits.push(c);
}
const ranked = [...groups.values()].sort((a, b) => (b.exact + b.eol) - (a.exact + a.eol) || a.missing - b.missing || b.exact - a.exact);
const best = ranked[0], second = ranked[1];
const match = best.exact + best.eol;
if (match === 0) {
  say('sourceGit: UNKNOWN (GIT_SOURCE_NO_EXACT_MATCH)');
  say('  sourcesContent may be transformed; wrong repository or unavailable history are also possible. Transformation is not established by a mismatch alone.');
  say('commit: NONE');
  say('dirtyBuild: UNKNOWN');
  say(`Diagnostic comparison only: ${commits.length} commits / ${ranked.length} source groups inspected; 0 exact/EOL matches. Candidate selection and source diffs suppressed.`);
  if (warnings.length) { say('Metadata warnings:'); for (const w of warnings) say(`  ! ${w}`); }
  say('Artifact-level attribution: NOT_ESTABLISHED');
  say('Classification: UNKNOWN');
  say('Evidence level: UNKNOWN');
  say('Reason: no recovered source file matches an inspected committed blob; no dirty-build inference');
  flush();
}
const describeGroup = (g) => {
  const cs = g.commits;
  const head = `commit ${short(cs[0].h)} (${new Date(cs[0].t * 1000).toISOString().slice(0, 10)}) "${cs[0].s.slice(0, 60)}"`;
  return cs.length === 1 ? head : `${head}\n    + ${cs.length - 1} other commit(s) with identical blobs for these files: ${cs.slice(1, 6).map((c) => short(c.h)).join(', ')}${cs.length > 6 ? ', ...' : ''}`;
};

say('');
say('Best source-state candidate (sourcesContent only, not verified artifact origin):');
say('  ' + describeGroup(best));
say(`  files: ${best.exact} exact, ${best.eol} line-ending-only, ${best.diff} differ, ${best.missing} absent in commit  (of ${tracked.length})`);
if (second && second.exact + second.eol === match && second.missing === best.missing) {
  say('Competing candidate (same score):');
  say('  ' + describeGroup(second));
}

// ---------- 5. differences vs best candidate ----------
function lineDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const A = a.slice(p, sa), B = b.slice(p, sb);
  if (A.length * B.length > 4e6) return { add: B.map((l, i) => [p + i + 1, l]), del: A.map((l, i) => [p + i + 1, l]), approx: true };
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const add = [], del = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; }
    else if (j < B.length && (i === A.length || dp[i][j + 1] >= dp[i + 1][j])) { add.push([p + j + 1, B[j]]); j++; }
    else { del.push([p + i + 1, A[i]]); i++; }
  }
  return { add, del };
}

const diffs = [];
for (const s of tracked) {
  const b = best.tree.get(s.repoPath);
  if (b && s.variants.has(b)) continue;
  const d = { s, notes: [] };
  if (b) {
    const committed = gitBuf(['cat-file', '-p', b]).toString('utf8').replace(/\r\n/g, '\n');
    const artifactSrc = s.content.replace(/\r\n/g, '\n');
    d.diff = lineDiff(committed.split('\n'), artifactSrc.split('\n'));
    if (committed.replace(/\s+/g, '') === artifactSrc.replace(/\s+/g, '')) d.notes.push('whitespace-only difference');
  } else d.notes.push('file absent in candidate commit');
  const elsewhere = blobWhere.get(s.hash) || [];
  const other = elsewhere.find((w) => w.path === s.repoPath) || elsewhere[0];
  if (other) d.notes.push(`this exact content exists in history: ${other.path} @ ${short(other.commit.h)} "${other.commit.s.slice(0, 50)}" (mixed/cherry-picked/reverted file, not necessarily uncommitted)`);
  const wt = path.join(repo, s.repoPath);
  if (fs.existsSync(wt)) {
    const wtHash = blobHash(fs.readFileSync(wt));
    if (s.variants.has(wtHash)) d.notes.push('identical to the CURRENT working-tree file (content observation only, not proof of an uncommitted build)');
  }
  diffs.push(d);
}

say('');
say('Recovered-source differences vs candidate (not proof of dirty build):');
if (diffs.length === 0) say('  none (recovered sources match the candidate blob-for-blob' + (best.eol ? ', ignoring line endings' : '') + ')');
let uncommittedLike = 0;
for (const d of diffs) {
  say(`  ${d.s.repoPath}` + (d.diff ? `   +${d.diff.add.length} lines  -${d.diff.del.length} lines${d.diff.approx ? ' (approx)' : ''}` : ''));
  for (const n of d.notes) say(`    note: ${n}`);
  if (!d.notes.some((n) => n.startsWith('this exact content exists'))) uncommittedLike++;
  if (d.diff) {
    const lines = [...d.diff.del.map(([n, l]) => ['-', n, l]), ...d.diff.add.map(([n, l]) => ['+', n, l])].sort((x, y) => x[1] - y[1]);
    for (const [sign, n, l] of lines.slice(0, showLines)) say(`    ${sign} ${String(n).padStart(4)} | ${l.slice(0, 100)}`);
    if (lines.length > showLines) say(`    ... ${lines.length - showLines} more changed lines`);
  }
}

// ---------- 6. classification + evidence level ----------
let cls, evidence, why;
const tie = second && second.exact + second.eol === match && second.missing === best.missing;
if (match === 0) { cls = 'UNKNOWN'; evidence = 'UNKNOWN'; why = 'no recovered source file matches any committed blob'; }
else if (tie) { cls = 'AMBIGUOUS'; evidence = 'WEAK_CANDIDATE'; why = 'two different source states score equally'; }
else if (diffs.length === 0) {
  if (best.commits.length === 1) { cls = 'EXACT_COMMIT_MATCH'; evidence = 'EXACT'; why = 'every recovered source equals this commit and no other inspected commit'; }
  else { cls = 'AMBIGUOUS'; evidence = 'STRONG_CANDIDATE'; why = `source state is exact, but ${best.commits.length} commits contain these identical files; the artifact cannot tell them apart`; }
} else {
  cls = uncommittedLike > 0 ? 'DIRTY_FROM_COMMIT' : 'AMBIGUOUS';
  const ratio = match / tracked.length;
  evidence = ratio >= 0.6 ? 'STRONG_CANDIDATE' : 'WEAK_CANDIDATE';
  why = uncommittedLike > 0
    ? `${match}/${tracked.length} files equal the candidate; ${uncommittedLike} file(s) contain content found in NO inspected commit => possible uncommitted build-time change (or source transformation / unavailable history)`
    : 'differing files match other commits (mixed tree), no content outside history';
  if (best.commits.length > 1) why += `; base is one of ${best.commits.length} source-identical commits`;
}
const sourceGit = tie ? 'AMBIGUOUS' : diffs.length === 0 ? 'EXACT' : 'NEAR';
const dirtyBuild = !tie && uncommittedLike > 0 && artifactMap.status === 'COMPATIBLE'
  ? 'POSSIBLE' : diffs.length === 0 ? 'NOT_INDICATED' : 'UNKNOWN';
// Compatibility abstention cannot weaken source-Git evidence or prove an artifact
// mismatch. It does prevent legacy exact/dirty summaries from implying attribution.
if (artifactMap.status !== 'COMPATIBLE' && ['EXACT_COMMIT_MATCH', 'DIRTY_FROM_COMMIT'].includes(cls)) {
  cls = 'AMBIGUOUS';
  why += '; artifact-map compatibility is not corroborated; source-state evidence is separate';
}

say('');
say(`sourceGit: ${sourceGit} (${match}/${tracked.length} exact/EOL; source evidence ${evidence})`);
say(`commit: ${tie ? 'AMBIGUOUS_GROUPS' : 'CANDIDATE_GROUP'} (${best.commits.length} source-identical commits in leading group; not a unique build attribution)`);
say(`dirtyBuild: ${dirtyBuild}${dirtyBuild === 'POSSIBLE' ? ' (hypothesis only; transformations or unavailable history can also explain the difference)' : ''}`);
say('Artifact-level attribution: NOT_ESTABLISHED (no build attestation)');
if (warnings.length) { say('Trust warnings:'); for (const w of warnings) say('  ! ' + w); say(''); }
say(`Classification: ${cls}`);
say(`Evidence level: ${evidence}`);
say('Evidence scope: sourcesContent <-> inspected Git history, NOT combined artifact confidence');
say(`Reason: ${why}`);
say('Note: evidence describes the sourcemap contents; it is never proof of the machine/working tree that built the artifact.');
flush();

function flush() { console.log(out.join('\n')); process.exit(0); }
