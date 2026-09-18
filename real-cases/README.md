# Real-case reproduction

These two scripts reproduce real, published-package cases from public sources
only (npm registry + public GitHub clones). They are intentionally kept out
of `node --test regression.test.cjs` because they need network access and
take noticeably longer (the Redux case clones ~4,500 commits and inspects
all of them).

No credentials are used. Both scripts only read: they download a tarball,
clone a public repository read-only, and run `sourcemap-lineage.cjs`, which
itself only runs `git log` / `git ls-tree` / `git cat-file`.

```sh
node real-cases/reproduce-immer.cjs
node real-cases/reproduce-redux-negative.cjs
```

Each accepts `--work-dir <dir>` and `--repo <existing clone>` to reuse a
previous download/clone instead of fetching again.

## Immer 10.1.1 — positive candidate-narrowing case

`reproduce-immer.cjs` downloads `immer@10.1.1` from npm, verifies the
published `dist/immer.mjs` and its map against pinned SHA-256 hashes, reads
the npm registry's `gitHead` field for that version as **ground-truth
metadata only**, clones `immerjs/immer` on GitHub, and runs sourcemap-lineage.
The ground-truth commit is never passed to the tool — it is used solely by
this script, afterward, to check whether the tool's reported candidate group
happens to include it.

Expected result: `sourceGit: EXACT (12/12)`, a 2-commit candidate group that
includes the ground-truth commit, `artifactMap: UNKNOWN`,
`Classification: AMBIGUOUS`, `Evidence level: STRONG_CANDIDATE`,
`dirtyBuild: NOT_INDICATED`, `Artifact-level attribution: NOT_ESTABLISHED`.

This is presented as **candidate narrowing**, not as proof: the tool
correctly narrows a large repository down to two commits that could have
produced the artifact, and correctly refuses to pick one of them.

## Redux 5.0.1 — negative / abstention case

`reproduce-redux-negative.cjs` does the same for `redux@5.0.1`'s
`dist/redux.browser.mjs`. No recovered source in this artifact's map matches
any blob in the repository's inspected history (0/10 sources). This is a
useful negative case: it demonstrates that when there is genuinely no
source-Git evidence, the tool abstains (`UNKNOWN` across every axis, no
best-guess candidate, no source diff) rather than presenting a misleading
answer.

## What these cases do not establish

Neither case is build provenance. Confirming that a package's published
artifact source-matches (or doesn't match) Git history says nothing about
which machine, environment, or exact build step produced the bytes on npm.
See the main `README.md`'s "What it does NOT prove" section.
