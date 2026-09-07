'use strict';
// CLAUDE.md Item 1: a failed or cancelled detection run must never commit as
// an empty success.
//
// _ccDetectionResultUsable used to early-return `true` unless the
// concurrencyV2 migration flag (defaultEnabled:false) was on -- so in the
// shipped default configuration, cancelling a run or a thrown exception
// mid-run resolved a bare `[]`, which _ccCommitDetectionResult happily
// treated as a genuinely complete zero-clash run: MERGE_CLASHES auto-resolved
// up to 200 prior clashes and permanently deleted any beyond that. This file
// locks the fix: the guard is unconditional (flag on or off), and each of
// the three outcomes (cancel, throw, genuine completion) is distinguishable.
//
// detection-concurrency-v2.test.js already covers the concurrencyV2-enabled
// coordinator paths (already-running / stale-generation via the coordinator)
// with the flag explicitly ON. This file deliberately leaves the flag at its
// DEFAULT (disabled) to prove the guard now works without it -- that is the
// entire point of this fix -- and additionally exercises the _browserDetect
// exception path (`_ccLastDetectError`, STOP_DETECT, no commit), which the
// concurrencyV2 harness stubs out entirely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const safety = require('../safety-migrations');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `missing start marker: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `missing end marker: ${endText}`);
  return source.slice(start, end);
}

// Loads the real detectClashesAsync / cancelDetection / _browserDetect /
// commit-guard pipeline, but stubs out _detectClashesCore (the actual
// geometry engine -- thousands of lines, BVH/spatial-hash internals
// genuinely out of scope for this fix) and _preExtractGLBGeometry so a test
// can drive _browserDetect's own promise machinery directly.
function loadHarness(detectClashesCoreImpl) {
  const core = between('var _DETECT_CHUNK_SIZE', 'function _detectClashesCore(');
  const dispatches = [];
  const toasts = [];
  const events = [];
  const classified = [];
  const context = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    Promise,
    Object,
    Array,
    isFinite,
    CustomEvent: function(type, init) { this.type = type; this.detail = init && init.detail; },
    Event: function(type) { this.type = type; },
    A: { MERGE_CLASHES: 'MERGE_CLASHES' },
    classifyClashes(result) { classified.push(result); },
    _preExtractGLBGeometry() { return Promise.resolve(); },
    _detectClashesCore: detectClashesCoreImpl,
  };
  context.window = context;
  context.window._ccSafetyMigrations = safety;
  context.window._ccLatestState = {};
  context.window._ccDispatch = function(action) { dispatches.push(action); };
  context.window._ccToast = function(msg) { toasts.push(msg); };
  context.window.dispatchEvent = function(e) { events.push(e); };
  vm.createContext(context);
  vm.runInContext(core, context);
  return {
    context, dispatches, toasts, events, classified,
    dispatch(action) { dispatches.push(action); },
  };
}

test.beforeEach(() => safety._setFlagsForTest({}));
test.afterEach(() => safety._setFlagsForTest({}));

function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('default config (concurrencyV2 OFF): a cancelled run does not commit', async () => {
  let resolveCore;
  const harness = loadHarness((models, rules, onProgress, resolveAsync) => {
    // Simulate the chunked async path: the core hands back its result via
    // resolveAsync, later, after the caller has had a chance to cancel.
    resolveCore = resolveAsync;
    return undefined; // signal "async path taken", per the real contract
  });
  const run = harness.context.detectClashesAsync([{ id: 'm' }], {});
  await nextMacrotask(); // let _preExtractGLBGeometry's .then reach _detectClashesCore
  // User clicks "Stop detection" mid-run.
  harness.context.cancelDetection();
  // The in-flight core keeps going for a beat and hands back a (would-be)
  // clash it found before the cancel landed -- this must NOT survive.
  resolveCore([{ id: 'late-clash' }]);
  const result = await run;

  assert.equal(result._ccOutcome, 'cancelled');
  assert.equal(harness.context._ccDetectionResultUsable(result), false);
  assert.equal(harness.context._ccCommitDetectionResult(result, harness.dispatch), false);
  assert.equal(harness.dispatches.some((a) => a.t === 'MERGE_CLASHES'), false,
    'a cancelled run must never dispatch MERGE_CLASHES');
  assert.equal(harness.classified.length, 0);
});

test('default config (concurrencyV2 OFF): a run whose core throws does not commit, and surfaces the failure', async () => {
  const harness = loadHarness(() => {
    throw new Error('boom: narrow-phase blew up');
  });
  const result = await harness.context.detectClashesAsync([{ id: 'm' }], {});

  assert.equal(result._ccOutcome, 'failed');
  assert.equal(harness.context._ccDetectionResultUsable(result), false);
  assert.equal(harness.context._ccCommitDetectionResult(result, harness.dispatch), false);
  assert.equal(harness.dispatches.some((a) => a.t === 'MERGE_CLASHES'), false,
    'a failed run must never dispatch MERGE_CLASHES');
  assert.equal(harness.classified.length, 0);

  // The catch(e) block must surface the failure the same way the existing
  // .catch() handlers elsewhere do: populate window._ccLastDetectError...
  assert.ok(harness.context.window._ccLastDetectError);
  assert.match(harness.context.window._ccLastDetectError.message, /boom/);
  // ...and not leave the UI stuck spinning, since several call sites of
  // detectClashesAsync have no .catch() of their own and rely on
  // MERGE_CLASHES (which this run correctly never dispatches) to clear it.
  assert.ok(harness.dispatches.some(function(a) { return a.t === 'STOP_DETECT'; }),
    'a thrown core must still clear the detecting spinner directly');
});

test('default config (concurrencyV2 OFF): a genuinely complete run with zero clashes DOES commit', async () => {
  const harness = loadHarness((models, rules, onProgress) => {
    return []; // synchronous "found nothing" completion
  });
  const result = await harness.context.detectClashesAsync([{ id: 'm' }], {});

  assert.equal(result._ccOutcome, 'complete');
  assert.equal(harness.context._ccDetectionResultUsable(result), true);
  assert.equal(harness.context._ccCommitDetectionResult(result, harness.dispatch), true);
  assert.equal(harness.dispatches.length, 1);
  assert.equal(harness.dispatches[0].t, 'MERGE_CLASHES');
  assert.deepEqual(harness.dispatches[0].v, []);
  assert.equal(harness.classified.length, 1);
});

test('default config (concurrencyV2 OFF): a genuinely complete run with real clashes DOES commit', async () => {
  const harness = loadHarness(() => [{ id: 'real-clash' }]);
  const result = await harness.context.detectClashesAsync([{ id: 'm' }], {});

  assert.equal(result._ccOutcome, 'complete');
  assert.equal(harness.context._ccCommitDetectionResult(result, harness.dispatch), true);
  assert.equal(harness.dispatches.length, 1);
  assert.equal(harness.dispatches[0].v[0].id, 'real-clash');
});

test('a stale (superseded) generation cannot commit even with concurrencyV2 OFF', async () => {
  // A second run starts while the first's core is still in flight -- no
  // cancel, just a fresh run superseding the first (e.g. the user tweaked
  // rules and hit Run again before the old one finished). One stub function
  // tells the two calls apart by order: the first run's core goes async and
  // is held open (exercising the same "generation moved on mid-flight" path
  // _detectClashesCore's own chunk loop hits internally); the second's
  // completes synchronously.
  let resolveCore;
  let callCount = 0;
  const harness = loadHarness((models, rules, onProgress, resolveAsync) => {
    callCount++;
    if (callCount === 1) { resolveCore = resolveAsync; return undefined; }
    return [{ id: 'second-run-clash' }];
  });
  const first = harness.context.detectClashesAsync([{ id: 'm' }], {});
  // Let the first run's _browserDetect actually reach _detectClashesCore
  // (setting resolveCore) before the second run bumps the generation --
  // otherwise the first run's own pre-core generation check would short-
  // circuit it before the core is ever invoked (a different, earlier-exit
  // code path, also correct, but not what this test is targeting).
  await nextMacrotask();
  const second = harness.context.detectClashesAsync([{ id: 'm' }], {});
  const secondResult = await second;
  // The first run's core "finishes" after the second has already landed.
  resolveCore([{ id: 'first-run-late-clash' }]);
  const firstResult = await first;

  assert.equal(callCount, 2, 'both cores should have actually run');
  assert.equal(firstResult._ccOutcome, 'stale-generation');
  assert.equal(harness.context._ccCommitDetectionResult(firstResult, harness.dispatch), false);
  assert.equal(secondResult._ccOutcome, 'complete');
  assert.equal(harness.context._ccCommitDetectionResult(secondResult, harness.dispatch), true);
  assert.equal(harness.dispatches.length, 1);
  assert.equal(harness.dispatches[0].v[0].id, 'second-run-clash');
});
