'use strict';

// Diagnostics, not a source-map validator or a build attestation. In particular,
// original names and short generated identifiers are NOT independent proof of fit.
function inspectMap(artifact, map, linked = true) {
  const result = { status: 'UNKNOWN', reasons: [], mappings: 0, coordinateErrors: 0,
    malformedSegments: 0, comparable: 0, unchangedNames: 0, possibleRenames: 0,
    shortGeneratedNames: 0, contextAnchors: 0, anchorSources: 0 };
  if (map.version !== 3 || map.sections || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) {
    result.reasons.push('unsupported or incomplete map structure; compatibility not assessed');
    return result;
  }
  // Columns exclude line terminators. CRLF is one line break, not a trailing
  // content character that should invalidate a matching source suffix.
  const gen = artifact.split(/\r\n|\r|\n/);
  const src = (map.sourcesContent || []).map(s => typeof s === 'string' ? s.split(/\r\n|\r|\n/) : null);
  const names = Array.isArray(map.names) ? map.names : [];
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const token = (line, col) => typeof line === 'string' && col >= 0
    ? (/^[A-Za-z_$][\w$]*/.exec(line.slice(col)) || [])[0] : null;
  const atBoundary = (line, col) => col === 0 || !/[\w$]/.test(line[col - 1]);
  const anchors = new Set(), anchorSources = new Set(), mappedSources = new Set();
  let si = 0, sl = 0, sc = 0, ni = 0;
  map.mappings.split(';').forEach((line, gl) => {
    let gc = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const values = [];
      let value = 0, shift = 0, invalid = false;
      for (const ch of seg) {
        const d = b64.indexOf(ch);
        if (d < 0 || shift > 45) { invalid = true; break; }
        value += (d & 31) * 2 ** shift;
        if (d & 32) shift += 5;
        else { values.push(value % 2 ? -Math.floor(value / 2) : value / 2); value = 0; shift = 0; }
      }
      if (invalid || shift || ![1, 4, 5].includes(values.length) || !values.every(Number.isSafeInteger)) {
        result.malformedSegments++;
        continue;
      }
      const previousColumn = gc;
      gc += values[0];
      let bad = gc < previousColumn || gc < 0 || gl >= gen.length || gc > (gen[gl] || '').length;
      if (values.length === 1) { if (bad) result.coordinateErrors++; continue; }
      si += values[1]; sl += values[2]; sc += values[3];
      if (values.length === 5) ni += values[4];
      result.mappings++;
      bad ||= si < 0 || si >= map.sources.length || sl < 0 || sc < 0;
      bad ||= values.length === 5 && (ni < 0 || ni >= names.length);
      const sourceLine = src[si]?.[sl];
      if (src[si]) bad ||= sl >= src[si].length || sc > (sourceLine || '').length;
      if (bad) { result.coordinateErrors++; continue; }
      mappedSources.add(si);
      const st = token(sourceLine, sc), gt = token(gen[gl], gc);
      if (st && st.length >= 3) {
        result.comparable++;
        if (gt === st) result.unchangedNames++;
        else if (gt && gt.length <= 2) result.shortGeneratedNames++;
      }
      if (values.length === 5 && names[ni] === st && gt && gt !== st &&
          atBoundary(sourceLine, sc) && atBoundary(gen[gl], gc)) result.possibleRenames++;
      // Positive *context* corroboration, not a name-retention threshold. Deliberately
      // abstains on minified output. Trim indentation only; do not rewrite strings/code.
      if (st && gt === st && sourceLine.trim().length >= 20 && sourceLine.trim() === gen[gl].trim() &&
          sourceLine.slice(sc) === gen[gl].slice(gc)) {
        anchors.add(`${si}:${sl}:${gl}`);
        anchorSources.add(si);
      }
    }
  });
  result.contextAnchors = anchors.size;
  result.anchorSources = anchorSources.size;
  if (result.coordinateErrors || result.malformedSegments) {
    result.status = 'INCOMPATIBLE';
    result.reasons.push('mapping structure or coordinates are inconsistent with the supplied inputs; cause not inferred');
  } else if (linked && result.mappings && mappedSources.size &&
      [...mappedSources].every(i => src[i]) && anchors.size >= 50 &&
      anchorSources.size === mappedSources.size) {
    result.status = 'COMPATIBLE';
    result.reasons.push('mapped whole-line context corroborates compatibility (heuristic, not validity or provenance proof)');
  } else {
    result.reasons.push('compatibility not established; valid renaming/transforms and mismatched maps are both possible');
  }
  return result;
}

module.exports = { inspectMap };
