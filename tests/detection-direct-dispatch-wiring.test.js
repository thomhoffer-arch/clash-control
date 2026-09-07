'use strict';
// CLAUDE.md Item 1 (R2/R3 follow-up): two detection call sites used to
// dispatch MERGE_CLASHES directly, bypassing both the outcome guard (at the
// shipped default, concurrencyV2 off) and run-scope coverage (Item 2):
//   - the NL "self-clash on models X/Y/Z" multi-pass path
//   - _ccRunDetectionRuleset's final union commit
// This locks both are routed through the guarded commit helper, wired for
// coverage, and (the ruleset's per-rule loop) emit a terminal
// cc-detection-complete event on a bad sub-result instead of hanging an
// orchestrator that's awaiting it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(startText, endText, fromIndex) {
  const start = source.indexOf(startText, fromIndex || 0);
  assert.notEqual(start, -1, `missing start marker: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `missing end marker: ${endText}`);
  return source.slice(start, end);
}

// ── NL multi-self-clash path ────────────────────────────────────────────
const multiSelfBlock = between('function _runSelfPass(pass) {', '\n      function _labelFor');

test('NL multi-self-clash path: no longer dispatches MERGE_CLASHES directly', () => {
  assert.doesNotMatch(multiSelfBlock, /d\(\{t:A\.MERGE_CLASHES/);
});

test('NL multi-self-clash path: routes through the guarded commit helper', () => {
  assert.match(multiSelfBlock, /_ccCommitDetectionResult\(tagged, d, \{coverageModelIds: multiSelf\.map/);
});

test('NL multi-self-clash path: a bad sub-result outcome is threaded into the tagged combined result', () => {
  assert.match(multiSelfBlock, /if \(!badOutcome && !_ccDetectionResultUsable\(r\)\) badOutcome = /);
  assert.match(multiSelfBlock, /_ccTagDetectionResult\(allClashes, _ccDetectGeneration, badOutcome \|\| 'complete'\)/);
});

test('NL multi-self-clash path: this used to run unguarded at the shipped default (documented regression this locks)', () => {
  // The coordinated (concurrencyV2-enabled) branch already checked
  // _ccDetectionResultUsable per sub-pass; the plain Promise.all branch
  // (the shipped default) had no check at all before this fix. Confirm
  // the doc/rationale comment explaining why is still present, so a future
  // editor doesn't strip the guard back out under the impression it was
  // always redundant.
  assert.match(multiSelfBlock, /no usability check at the shipped\s*\n\s*\/\/ default/);
});

// ── _ccRunDetectionRuleset ───────────────────────────────────────────────
const rulesetBlock = between(
  'window._ccRunDetectionRuleset = function(rules) {',
  '\n  // ── Reducer'
);

test('_ccRunDetectionRuleset: the final union commit no longer dispatches MERGE_CLASHES directly', () => {
  assert.doesNotMatch(rulesetBlock, /d\(\{t:'MERGE_CLASHES'/);
});

test('_ccRunDetectionRuleset: the final union commit routes through the guarded commit helper with coverage', () => {
  assert.match(rulesetBlock, /_ccCommitDetectionResult\(tagged, d, \{coverageModelIds: Object\.keys\(_coverageIds\)\}\)/);
});

test('_ccRunDetectionRuleset: each rule\'s resolved scope is folded into the coverage union', () => {
  assert.match(rulesetBlock, /_ccCoverageModelIds\(merged, s\.models\)/);
});

test('_ccRunDetectionRuleset: a bad per-rule outcome emits a terminal cc-detection-complete event instead of hanging silently', () => {
  const perRuleBlock = between('if (!_ccDetectionResultUsable(result)) {', 'return;\n        }\n        (result || []).forEach', rulesetBlock.indexOf('detectClashesAsync'));
  assert.match(perRuleBlock, /new CustomEvent\('cc-detection-complete'/);
  assert.match(perRuleBlock, /ok:false/);
});

// ── _ccCommitDetectionResult: cancelled outcome gets a terminal event ────
const commitBlock = between(
  'function _ccCommitDetectionResult(result, dispatch, detectionSettings, opts) {',
  'window._ccCommitDetectionResult = _ccCommitDetectionResult;'
);

test('_ccCommitDetectionResult emits cc-detection-complete for a blocked "cancelled" commit (orchestrator must not hang)', () => {
  assert.match(commitBlock, /result && result\._ccOutcome === 'cancelled'/);
  assert.match(commitBlock, /new CustomEvent\('cc-detection-complete'/);
});

test('_ccCommitDetectionResult does NOT re-dispatch a terminal event for stale-generation/already-running (a different, newer run owns that)', () => {
  // The cancelled-only condition must be scoped narrowly -- these two
  // outcomes mean another run is (or was) actually in flight and will
  // report its own completion.
  const guardBody = commitBlock.slice(0, commitBlock.indexOf('classifyClashes(result)'));
  const cancelledCheckIdx = guardBody.indexOf("_ccOutcome === 'cancelled'");
  assert.notEqual(cancelledCheckIdx, -1);
  // No unconditional dispatch outside the cancelled-only branch.
  const beforeCancelledCheck = guardBody.slice(0, cancelledCheckIdx);
  assert.doesNotMatch(beforeCancelledCheck, /new CustomEvent\('cc-detection-complete'/);
});
