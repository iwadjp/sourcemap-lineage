'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { inspectMap } = require('./map-evidence.cjs');
const run = promisify(execFile);
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const cli = path.join(__dirname, 'sourcemap-lineage.cjs');
const generator = path.join(__dirname, 'fixtures', 'generate-fixtures.cjs');
const fixturesOut = path.join(__dirname, 'fixtures', 'generated');
const unitMap = mappings => ({ version: 3, sources: ['source.js'], sourcesContent: ['longName'], names: ['longName'], mappings });

test('map evidence: abstention and independent structural contradictions', async t => {
  await t.test('names and short generated tokens alone do not establish compatibility', () => {
    const r = inspectMap('x', unitMap('AAAAA'));
    assert.equal(r.status, 'UNKNOWN'); assert.equal(r.possibleRenames, 1);
    assert.equal(r.shortGeneratedNames, 1); assert.equal(r.coordinateErrors, 0);
  });
  await t.test('generated coordinates out of range', () => {
    assert.equal(inspectMap('x', unitMap('EAAA')).status, 'INCOMPATIBLE');
  });
  await t.test('source coordinates out of range', () => {
    assert.equal(inspectMap('x', unitMap('AAEA')).status, 'INCOMPATIBLE');
  });
  await t.test('invalid names index', () => {
    assert.equal(inspectMap('x', unitMap('AAAAC')).status, 'INCOMPATIBLE');
  });
  await t.test('malformed VLQ/segment shapes do not pass', () => {
    for (const s of ['!', 'g', 'AA']) assert.equal(inspectMap('x', unitMap(s)).status, 'INCOMPATIBLE');
  });
  await t.test('empty/unsupported maps abstain', () => {
    assert.equal(inspectMap('x', unitMap('')).status, 'UNKNOWN');
    assert.equal(inspectMap('x', { version: 3, sections: [] }).status, 'UNKNOWN');
  });
  await t.test('CRLF source and LF artifact preserve whole-line/column corroboration', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `const retainedValue${i} = usefulFunction(${i});`);
    const m = { version: 3, sources: ['source.js'], sourcesContent: [lines.join('\r\n')], names: [], mappings: 'AAAA;' + Array(59).fill('AACA').join(';') };
    assert.equal(inspectMap(lines.join('\n'), m).status, 'COMPATIBLE');
    // Matching text on a line is insufficient if the mapped column is wrong.
    assert.equal(inspectMap(lines.join('\n'), { ...m, mappings: 'CAAA;' + Array(59).fill('CACA').join(';') }).status, 'UNKNOWN');
    assert.equal(inspectMap(lines.join('\n'), m, false).status, 'UNKNOWN');
  });
});

test('fixed-artifact regression (synthetic fixtures only; no private repo, no network, no download)', { concurrency: 3 }, async t => {
  const codeHashes = { cli: hash(cli), mapEvidence: hash(path.join(__dirname, 'map-evidence.cjs')) };

  // Regenerate the synthetic fixture repo + artifacts deterministically (fixed author/
  // committer identity and timestamps -> byte-identical output every run, on any machine).
  execFileSync(process.execPath, [generator, fixturesOut], { encoding: 'utf8' });

  const repo = path.join(fixturesOut, 'repo');
  const art = name => path.join(fixturesOut, 'artifacts', name, 'app.js');

  const fixtures = [
    {
      name: 'clean', artifact: art('A-clean'), repo,
      check: s => { assert.match(s, /Classification: EXACT_COMMIT_MATCH/); assert.match(s, /Evidence level: EXACT/); assert.match(s, /artifactMap: COMPATIBLE/); assert.match(s, /sourceGit: EXACT/); assert.match(s, /commit: CANDIDATE_GROUP \(1 source-identical/); assert.match(s, /dirtyBuild: NOT_INDICATED/); },
    },
    {
      name: 'dirty', artifact: art('B-dirty'), repo,
      check: s => { assert.match(s, /Classification: DIRTY_FROM_COMMIT/); assert.match(s, /Evidence level: STRONG_CANDIDATE/); assert.match(s, /artifactMap: COMPATIBLE/); assert.match(s, /sourceGit: NEAR \(2\/3/); assert.match(s, /\+3 lines\s+-0 lines/); assert.match(s, /dirtyBuild: POSSIBLE/); },
    },
    {
      name: 'ambiguous-group', artifact: art('C-ambiguous-group'), repo,
      check: s => { assert.match(s, /Classification: AMBIGUOUS/); assert.match(s, /Evidence level: STRONG_CANDIDATE/); assert.match(s, /artifactMap: COMPATIBLE/); assert.match(s, /sourceGit: EXACT/); assert.match(s, /commit: CANDIDATE_GROUP \(2 source-identical/); assert.match(s, /cannot tell them apart/); assert.doesNotMatch(s, /Classification: EXACT_COMMIT_MATCH/); },
    },
    {
      name: 'stale-map', artifact: art('D-stale-map'), repo,
      check: s => { assert.match(s, /Classification: AMBIGUOUS/); assert.match(s, /artifactMap: INCOMPATIBLE/); assert.match(s, /sourceGit: EXACT/); assert.match(s, /commit: CANDIDATE_GROUP \(1 source-identical/); assert.match(s, /artifact-map compatibility is not corroborated/); assert.doesNotMatch(s, /Classification: EXACT_COMMIT_MATCH/); },
    },
    {
      name: 'eol-only', artifact: art('E-eol-only'), repo,
      check: s => { assert.match(s, /Classification: EXACT_COMMIT_MATCH/); assert.match(s, /artifactMap: COMPATIBLE/); assert.match(s, /sourceGit: EXACT \(3\/3/); assert.match(s, /1 line-ending-only/); },
    },
  ];

  const results = [];
  try {
    await Promise.all(fixtures.map(f => t.test(f.name, { timeout: 60000 }, async () => {
      const args = [cli, f.artifact, '--repo', f.repo, '--max-commits', '100', '--lines', '8'];
      const start = Date.now();
      const { stdout, stderr } = await run(process.execPath, args, { maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
      const record = {
        fixture: f.name, artifactHash: hash(f.artifact), mapHash: hash(f.artifact + '.map'),
        elapsedMs: Date.now() - start, stdout, stderr, passed: false,
      };
      results.push(record);
      assert.match(stdout, /Artifact-level attribution: NOT_ESTABLISHED/);
      f.check(stdout);
      record.passed = true;
    })));
    assert.deepEqual({ cli: hash(cli), mapEvidence: hash(path.join(__dirname, 'map-evidence.cjs')) }, codeHashes, 'code changed during regression');
  } finally {
    fs.writeFileSync(
      path.join(__dirname, 'regression-results.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), codeHashes, allFixturesPassed: results.length === fixtures.length && results.every(r => r.passed), results }, null, 2) + '\n',
    );
  }
});
