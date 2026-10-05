# sourcemap-lineage

Relate JavaScript sourcemap `sourcesContent` to Git history while preserving
commit ambiguity.

A read-only command-line tool that compares a JavaScript artifact's sourcemap
against a local Git repository's history, to narrow down which source state
could have produced it.

Japanese article: [sourcemapのsourcesContentは、どのcommitのsourceか特定できるか。Git historyと照合するsourcemap-lineage](https://blog2020.iwadjp.com/2026/09/18/sourcemap-lineage-sourcescontent-git-history/) - background and design notes for this tool.

**This does not prove build provenance or exact artifact origin.** This is a
candidate/source-lineage tool, not a build-provenance attestation system. See
"What it does NOT prove" below before relying on its output for anything.

## Problem

A `dist/*.js` file ships with a `.map` file that embeds `sourcesContent` — the
original source text at build time. Is there a way to relate that embedded
source back to real Git history, without just trusting the map blindly?

## What it does

- Recovers `sourcesContent` from a JS artifact's sourcemap.
- Compares the recovered source against a local Git repository's history
  (`git log`, `git ls-tree`, `git cat-file` only — nothing is written).
- Groups commits whose tracked files are blob-identical, so it never claims a
  single commit when several are indistinguishable from the artifact's point
  of view.
- Separately scores two independent things: whether the sourcemap's own
  structure plausibly corresponds to the artifact (`artifactMap`), and
  whether the recovered source content matches Git history (`sourceGit`).
- Flags recovered-source differences that don't match any inspected commit as
  a possible (never certain) uncommitted/dirty build.

## What it does NOT prove

- **Not** build provenance, **not** SLSA-equivalent, **not** a tamper-proof
  attestation.
- **Not** exact single-commit attribution — commits with identical tracked
  files are reported as a group, never collapsed to one.
- **Not** artifact authorship, and **not** proof of a dirty build — a
  `dirtyBuild: POSSIBLE` flag is a hypothesis, not a finding.
- Requires `sourcesContent` to be present in the map. Minified-only artifacts
  without embedded source text are mostly out of scope and will abstain.
- Cannot recover history that isn't present in the inspected repository, and
  cannot invert arbitrary source transformations (minification, bundling,
  codegen) back to the original text.

Every run prints `Artifact-level attribution: NOT_ESTABLISHED` — this is not
boilerplate, it reflects what the tool can and cannot establish.

## Quick start

Requirements:
- Node.js (uses the built-in `node:test` module). Tested on Node.js 24.
- `git` on `PATH` (developed and tested on git 2.51)
- A local, sufficiently complete clone of the repository the artifact was
  built from — completeness of history is the caller's responsibility, not
  something this tool can verify

```sh
node sourcemap-lineage.cjs <artifact.js> [--repo <path-to-git-repo>] [--max-commits N] [--lines N]
```

If `--repo` is omitted, the tool walks up from the artifact looking for a
`.git` directory. `--max-commits` (default 2000) bounds how much history is
inspected; `--lines` (default 12) bounds how many changed lines are printed
per differing file.

## Example

Run the synthetic fixtures (see "Development status" below) for a
self-contained example with no network access required:

```sh
node fixtures/generate-fixtures.cjs
node sourcemap-lineage.cjs fixtures/generated/artifacts/A-clean/app.js --repo fixtures/generated/repo
```

## Classification semantics

| Axis | Values | Meaning |
|---|---|---|
| `artifactMap` | `COMPATIBLE` / `INCOMPATIBLE` / `UNKNOWN` | Heuristic structural/context support, independent structural contradiction, or abstention. Never proof of a valid map. |
| `sourceGit` | `EXACT` / `NEAR` / `AMBIGUOUS` / `UNKNOWN` | Recovered source vs. inspected Git blobs (EOL-normalized). Independent of `artifactMap`. |
| `commit` | `CANDIDATE_GROUP` / `AMBIGUOUS_GROUPS` / `NONE` | Source-state candidates only. Commits with identical tracked-file content cannot be told apart. |
| `dirtyBuild` | `POSSIBLE` / `NOT_INDICATED` / `UNKNOWN` | Hypothesis only — transformations and missing history can produce the same signal. |

`COMPATIBLE` is deliberately narrow (see `RESULT-MODEL.md` for the exact
rule): it needs a linked map, valid structure, at least 50 distinct matching
whole mapped lines of 20+ characters, with at least one such anchor in every
mapped source. It is positive context corroboration, not a general map
validator — a normal minified map will usually abstain as `UNKNOWN` rather
than being marked incompatible or compatible.

**`STRONG_CANDIDATE` does not mean "strong confidence this artifact came
from this commit."** It describes source-to-Git match density only. You can
see `Classification: AMBIGUOUS` next to `Evidence level: STRONG_CANDIDATE` —
that combination is not a contradiction: the source content matched
strongly, but more than one commit shares that exact content, so which one
actually produced the artifact remains unresolved.

## Verified real case: Immer 10.1.1

Reproducible from public sources only — see `real-cases/reproduce-immer.cjs`
and `real-cases/README.md` for the full script and command.

- Artifact: `immer@10.1.1`'s published `dist/immer.mjs`
  (SHA-256 `251bf957417907396d567c1f85ada354075cc9b10f57b25d973de334ad2fc49a`)
- Ground-truth metadata (npm registry `gitHead` field, used only to validate
  the reproduction script — never passed to the tool):
  `e2d222bd4fb26abded04075c936290715e9ee335`
- sourcemap-lineage result: `sourceGit: EXACT (12/12)`, candidate group of 2
  commits (the ground-truth commit is one of them), `artifactMap: UNKNOWN`,
  `Classification: AMBIGUOUS`, `Evidence level: STRONG_CANDIDATE`,
  `dirtyBuild: NOT_INDICATED`, `Artifact-level attribution: NOT_ESTABLISHED`.

This shows the tool correctly narrowing to a small candidate group that
contains the true commit, while still refusing to claim a unique match or a
proven build origin — exactly the discipline described above.

## Negative / abstention case: Redux 5.0.1

Also reproducible from public sources — `real-cases/reproduce-redux-negative.cjs`.
The published `redux.browser.mjs` for `redux@5.0.1` does not match any
commit in the public repository's inspected history (0/10 sources match any
blob). sourcemap-lineage abstains cleanly: `Classification: UNKNOWN`, no
best-guess candidate, no source diff, no dirty inference — the desired
behavior when there is genuinely no source-Git evidence, rather than forcing
an answer.

## Limitations

- Structurally in-range stale/foreign maps can evade the `artifactMap`
  coordinate check; context anchors can survive partial edits.
  `COMPATIBLE` is corroboration, not a semantic guarantee.
- A source mismatch alone is never proof of a dirty build or of source
  transformation — both are named as possibilities, not conclusions.
- Completeness of the inspected Git history is assumed, not verified.
- Cannot recover arbitrary transformed sources (minification, bundler
  renaming beyond what a sourcemap already tracks).

## Development status

The `fixtures/` directory contains a fully synthetic fixture generator
(`generate-fixtures.cjs`) that builds a disposable dummy Git repository and
esbuild bundles covering five cases: a clean single-commit match, a dirty
(uncommitted-edit) build, a multi-commit source-identical ambiguity group, a
stale/incompatible map pairing, and an EOL-only difference. Generation is
deterministic (fixed synthetic author/timestamps) so regenerated fixtures
hash-match across machines. No private repository, no third-party source,
and no network access are involved in `regression.test.cjs`.

```sh
node --test regression.test.cjs
```

`real-cases/` holds separate, network-using scripts that reproduce the two
real-world cases above against live public npm/GitHub sources. They are not
part of `node --test` and are run explicitly.

## License

[PolyForm Noncommercial 1.0.0](LICENSE).
