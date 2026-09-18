# Conservative evidence model (2026-09-18)

Additive text statuses; no new export format or semantic source matcher.

| Axis | Values | Meaning |
|---|---|---|
| artifactMap | COMPATIBLE / INCOMPATIBLE / UNKNOWN | Heuristic context support / independent structural contradiction / abstention. Never VALID or proof. |
| sourceGit | EXACT / NEAR / AMBIGUOUS / UNKNOWN | Recovered source contents vs inspected Git blobs, allowing EOL normalization. Independent of map compatibility. |
| commit | CANDIDATE_GROUP / AMBIGUOUS_GROUPS / NONE | Source-state candidates only. Same-source commits cannot be distinguished. |
| dirtyBuild | POSSIBLE / NOT_INDICATED / UNKNOWN | Hypothesis only. Transformations and missing history can explain differences. |

Identifier retention, names-based possible renames and short generated names are diagnostics, not a validity score. String-regex survival is removed: it counts transformed imports/templates and can mistake text between quotes for literals.

Structural coordinate/VLQ errors can support INCOMPATIBLE, without guessing stale vs foreign vs postprocessing. COMPATIBLE is deliberately narrow: linked map, valid supported structure, available mapped source content, at least 50 distinct matching whole mapped lines of 20+ characters, with anchors in every mapped source. Only indentation is trimmed, and a mapped identifier and the entire suffix at the corresponding columns must also agree. Line terminators are excluded from column content (including CRLF). This is positive context corroboration for existing unminified fixtures, not a general map validator. Minified maps normally remain UNKNOWN; names[] alone never promotes them.

Legacy Classification/Evidence level lines remain. Evidence level is explicitly source-Git evidence, not a combined confidence. Legacy EXACT_COMMIT_MATCH and DIRTY_FROM_COMMIT summaries require corroborated artifact-map compatibility; otherwise the summary stays AMBIGUOUS while source-Git evidence remains intact. No artifact-level build provenance is proven, even when compatibility is corroborated.

Zero exact/EOL matches: sourceGit UNKNOWN, commit NONE, dirtyBuild UNKNOWN, Classification/Evidence UNKNOWN. Print aggregate diagnostic comparison counts, not a chosen Best candidate or source diff. Mention possible transformed sources, wrong repo, or unavailable history without asserting SOURCE_TRANSFORMED as fact.

Nonzero differences may be displayed as recovered-source differences, not dirty proof. Uncommitted-like content supports only POSSIBLE; when artifactMap is unresolved, dirtyBuild remains UNKNOWN. A current working-tree content match is not proof of an uncommitted edit or build origin.

Safety limits: context anchors may survive partial stale edits; range checks do not detect every semantic mismatch; valid minified maps may stay UNKNOWN. No arbitrary transform inversion, parser-level semantic comparison, history completeness guarantee, or true build provenance claim is added.
