'use strict';
// CLAUDE.md Item 2 wiring lock: index.html must actually pass a run's
// resolved model scope into clash-reconciliation-core's mergeDetectionResults
// as `options.coverage`, via the single source of truth for scope
// resolution (_ccResolveModelScope) -- not reimplement scope logic here.
//
// Three things are locked:
//  1. _ccCoverageModelIds resolves rules.modelA/modelB through the real
//     _ccResolveModelScope into a deduped model-id list.
//  2. index.html's mergeDetectionResults wrapper turns that id list into a
//     `coverage` predicate and passes it to the reconciliation core (and
//     omits it entirely for the legacy 2-arg call shape).
//  3. Every real detectClashesAsync call site that commits a result also
//     builds `coverageModelIds` via _ccCoverageModelIds before dispatching.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startText, endText, fromIndex) {
  const start = source.indexOf(startText, fromIndex || 0);
  assert.notEqual(start, -1, `missing start marker: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `missing end marker: ${endText}`);
  return source.slice(start, end + endText.length);
}

// (1) _ccResolveModelScope + _ccCoverageModelIds, loaded as two small
// self-contained function declarations (not the surrounding detection
// engine) so this stays a targeted unit test, not a heavy VM load.
function loadCoverageHelpers() {
  const resolveScope = slice(
    'function _ccResolveModelScope(models, id) {',
    'window._ccResolveModelScope = _ccResolveModelScope;'
  );
  const coverageIds = slice(
    'function _ccCoverageModelIds(rules, models) {',
    '\n\n',
    source.indexOf('function _ccCoverageModelIds(rules, models) {')
  );
  const body = resolveScope + '\n' + coverageIds + '\nreturn {_ccResolveModelScope, _ccCoverageModelIds};';
  const window = {};
  return new Function('window', body)(window);
}

function model(id, name) { return {id, name}; }

test('_ccCoverageModelIds resolves modelA/modelB through the real _ccResolveModelScope', () => {
  const { _ccCoverageModelIds } = loadCoverageHelpers();
  const models = [model('A', 'Arch'), model('B', 'Struct'), model('C', 'MEP'), model('D', 'Site')];

  const scoped = _ccCoverageModelIds({modelA: 'A', modelB: 'B'}, models);
  assert.deepEqual(scoped.sort(), ['A', 'B']);

  const all = _ccCoverageModelIds({modelA: 'all', modelB: 'all'}, models);
  assert.deepEqual(all.sort(), ['A', 'B', 'C', 'D']);

  // C and D are never mentioned by an A-B scoped rule set.
  assert.equal(scoped.includes('C'), false);
  assert.equal(scoped.includes('D'), false);
});

test('_ccCoverageModelIds never throws on missing rules/models', () => {
  const { _ccCoverageModelIds } = loadCoverageHelpers();
  assert.deepEqual(_ccCoverageModelIds(null, null), []);
  assert.deepEqual(_ccCoverageModelIds({}, []), []);
  assert.deepEqual(_ccCoverageModelIds(undefined, undefined), []);
});

// (2) The reconciliation wrapper (same loading pattern as
// clash-reconciliation-core-wiring.test.js) turns a coverageModelIds array
// into a real `coverage` predicate function, or omits it for the legacy
// 2-arg call shape existing callers/tests still use.
function loadReconciliationWrapper(candidateCore) {
  const start = source.indexOf('var _ccIdentityCore = window._ccClashIdentityCore;');
  const end = source.indexOf('\n\n', source.indexOf('function mergeDetectionResults(newClashes, prevClashes, coverageModelIds)', start));
  assert.ok(start >= 0 && end > start, 'reconciliation wiring block not found');
  const window = { _ccClashIdentityCore: require('../clash-identity-core'), _ccClashReconciliationCore: candidateCore };
  return new Function('window', source.slice(start, end) + ';return {mergeDetectionResults};')(window);
}

test('mergeDetectionResults wrapper builds options.coverage from coverageModelIds and passes it to the core', () => {
  let capturedDeps;
  const { mergeDetectionResults } = loadReconciliationWrapper({
    mergeDetectionResults: (next, prev, deps) => { capturedDeps = deps; return {clashes: [], deltaSummary: {}}; },
  });
  mergeDetectionResults([], [], ['A', 'B']);
  assert.equal(typeof capturedDeps.coverage, 'function');
  assert.equal(capturedDeps.coverage({modelAId: 'A', modelBId: 'B'}), true);
  assert.equal(capturedDeps.coverage({modelAId: 'C', modelBId: 'D'}), false, 'a C-D clash must read as out of coverage for an A-B scoped run');
});

test('mergeDetectionResults wrapper omits coverage for the legacy 2-arg call shape', () => {
  let capturedDeps;
  const { mergeDetectionResults } = loadReconciliationWrapper({
    mergeDetectionResults: (next, prev, deps) => { capturedDeps = deps; return {clashes: [], deltaSummary: {}}; },
  });
  mergeDetectionResults([], []);
  assert.equal(capturedDeps.coverage, undefined);
});

// (3) The reducer actually threads a.coverageModelIds through, and every
// commit-guarded detectClashesAsync call site builds it via
// _ccCoverageModelIds before the result reaches the reducer.
test('the MERGE_CLASHES reducer case passes a.coverageModelIds into mergeDetectionResults', () => {
  assert.match(source, /mergeDetectionResults\(a\.v, a\.t===A\.MERGE_CLASHES\?s\.clashes:\[\], a\.coverageModelIds\)/);
});

test('_ccCommitDetectionResult promotes coverageModelIds from either detectionSettings or opts onto the dispatched action', () => {
  const body = source.slice(
    source.indexOf('function _ccCommitDetectionResult(result, dispatch, detectionSettings, opts) {'),
    source.indexOf('window._ccCommitDetectionResult = _ccCommitDetectionResult;')
  );
  assert.match(body, /var _coverage = \(detectionSettings && detectionSettings\.coverageModelIds\) \|\| \(opts && opts\.coverageModelIds\);/);
  assert.match(body, /if \(_coverage\) action\.coverageModelIds = _coverage;/);
});

test('every real detectClashesAsync call site that commits a result builds coverageModelIds via _ccCoverageModelIds first', () => {
  const calls = [...source.matchAll(/detectClashesAsync\([^\n]+\)\.then\(function\(result\)\{/g)];
  assert.ok(calls.length >= 7, 'expected the UI, API, NL and bridge detection call sites');
  for (const match of calls) {
    // Look both a little before (opts/ds built ahead of the call) and after
    // (built inline in the .then callback, e.g. the Smart Bridge run path).
    // A call site may build it directly, or via the shared
    // _captureDetectionSettings helper (checked separately below) --
    // either counts as wired.
    const windowText = source.slice(Math.max(0, match.index - 400), match.index + 400);
    assert.ok(windowText.includes('_ccCoverageModelIds(') || windowText.includes('_captureDetectionSettings('),
      `no _ccCoverageModelIds(...)/_captureDetectionSettings(...) near byte ${match.index}`);
  }
});

test('the shared _captureDetectionSettings helper (used by runDetection + applyAndRun) builds coverageModelIds', () => {
  const body = slice('function _captureDetectionSettings(rules, models) {', 'function runDetection() {');
  assert.match(body, /coverageModelIds: _ccCoverageModelIds\(rules, models\)/);
});

test('the public ClashControl.runDetection() API builds coverageModelIds for its rulesOverride', () => {
  const body = slice('runDetection:     function(rulesOverride, opts){', 'benchEngine:');
  assert.match(body, /coverageModelIds: _ccCoverageModelIds\(r, st\.models\)/);
});
