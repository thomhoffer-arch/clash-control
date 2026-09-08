(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashReconciliationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var AUTO_RESOLVE_CAP = 200;

  // options.coverage: optional function(prevClash) -> boolean describing
  // whether THIS run could plausibly have rediscovered a given prior clash
  // (e.g. "both of its elements' models were within the resolved scope of
  // this run"). Absent it, every prior clash is treated as in-scope -- the
  // behaviour every existing caller/test already relies on. A previously
  // open/in_progress clash OUTSIDE coverage is never auto-resolved: it
  // survives unchanged (status untouched) with `_delta:'not_checked'`
  // instead. See index.html's wiring of this via _ccResolveModelScope for
  // the real caller -- a run scoped to models A-B must never flip a C-D
  // clash to auto_resolved just because this run didn't happen to look at
  // it. Deliberately coarse (model-pair scope only, not excludeSelf/
  // discipline-matrix/hard-vs-soft nuance) -- see CLAUDE.md Item 2.
  function _inCoverage(options, c) {
    return typeof options.coverage !== 'function' || !!options.coverage(c);
  }

  function mergeDetectionResults(newClashes, prevClashes, options) {
    options = options || {};
    var identityKey = options.computeClashIdentityKey;
    var clashPair = options.computeClashPair;
    var isDenied = options.isDeniedClash;
    if (typeof identityKey !== 'function' || typeof clashPair !== 'function' || typeof isDenied !== 'function') {
      throw new Error('Clash reconciliation requires identity and denied-clash dependencies');
    }

    newClashes = newClashes.filter(function(c){ return !isDenied(c); });
    if (!prevClashes || prevClashes.length === 0) {
      var now0 = options.now != null ? options.now : Date.now();
      var firstRun = newClashes.map(function(c, i) {
        return Object.assign({}, c, {_identityKey:identityKey(c), _delta:'new', _firstSeen:now0, _lastSeen:now0, _runCount:1, number:i+1});
      });
      return {clashes:firstRun, deltaSummary:{newCount:firstRun.length,persisting:0,autoResolved:0,ts:now0}};
    }
    var now = options.now != null ? options.now : Date.now();
    var prevByKey = {};
    prevClashes.forEach(function(c) {
      var key = identityKey(c);
      prevByKey[key] = c;
    });

    var newKeys = {};
    var merged = newClashes.map(function(c) {
      var key = identityKey(c);
      newKeys[key] = true;
      var prev = prevByKey[key];
      if (!prev) {
        var p = c.point || [0,0,0];
        var gx = Math.round(p[0]/0.5), gy = Math.round(p[1]/0.5), gz = Math.round(p[2]/0.5);
        var pair = clashPair(c);
        outer: for (var dx=-1; dx<=1; dx++) { for (var dy=-1; dy<=1; dy++) { for (var dz=-1; dz<=1; dz++) {
          if (dx===0 && dy===0 && dz===0) continue;
          var adjKey = pair+'@'+(gx+dx)+','+(gy+dy)+','+(gz+dz);
          var cand = prevByKey[adjKey];
          if (cand) {
            var pp = cand.point||[0,0,0];
            var distMm = Math.sqrt(Math.pow((p[0]-pp[0])*1000,2)+Math.pow((p[1]-pp[1])*1000,2)+Math.pow((p[2]-pp[2])*1000,2));
            if (distMm <= 300) { prev = cand; newKeys[adjKey] = true; break outer; }
          }
        }}}
      }
      if (prev) {
        return Object.assign({}, c, {
          id: prev.id,
          _identityKey: key,
          _delta: 'persisting',
          _firstSeen: prev._firstSeen || now,
          _lastSeen: now,
          _runCount: (prev._runCount || 1) + 1,
          _prevDepth: prev.distance,
          _prevPoint: prev.point,
          status: prev.status === 'auto_resolved' ? 'open' : prev.status,
          assignee: prev.assignee,
          priority: prev.priority,
          aiSignals: prev.aiSignals,
          aiFeedback: prev.aiFeedback,
          aiReasons: prev.aiReasons,
          aiResolution: prev.aiResolution,
          aiNote: prev.aiNote,
          aiSeverity: prev.aiSeverity,
          aiCategory: prev.aiCategory,
          aiReason: prev.aiReason,
          _clusterGroup: prev._clusterGroup,
          _clusterSize: prev._clusterSize,
          clashTypeConfirmed: prev.clashTypeConfirmed,
          linkedIssueId: prev.linkedIssueId,
        });
      }
      return Object.assign({}, c, {_identityKey:key, _delta:'new', _firstSeen:now, _lastSeen:now, _runCount:1});
    });

    var arCount = 0, arOverflow = 0, notChecked = 0;
    prevClashes.forEach(function(c) {
      var key = identityKey(c);
      if (newKeys[key] || !(c.status==='open' || c.status==='in_progress')) return;
      if (!_inCoverage(options, c)) {
        // This run's scope never touched this clash -- it wasn't
        // rediscovered because it was never checked, not because it went
        // away. Preserve it exactly (status untouched) so it stays
        // addressable, distinguishable from a genuine auto-resolve.
        notChecked++;
        merged.push(Object.assign({}, c, {_identityKey:key, _delta:'not_checked'}));
        return;
      }
      if (arCount >= AUTO_RESOLVE_CAP) {
        // Cap how many auto-resolve per run, but never drop the record --
        // it keeps its prior status (assignee/comments/history intact) and
        // simply isn't flipped this run. deltaSummary reports it via
        // autoResolvedTruncated, separate from the real autoResolved count
        // (R3 follow-up: autoResolved used to add arOverflow on top of the
        // records that actually flipped, over-reporting "205 auto-resolved"
        // when only 200 did and 5 stayed open). _delta is explicitly set
        // (not left as whatever stale value `c` carried from a PRIOR run's
        // _delta, e.g. a leftover 'persisting') so it's never confused with
        // a fresh not_checked/auto_resolved/persisting/new record --
        // _delta is user-visible (badges, filters).
        arOverflow++;
        merged.push(Object.assign({}, c, {_identityKey:key, _delta:'auto_resolve_capped'}));
        return;
      }
      merged.push(Object.assign({}, c, {_identityKey:key, _delta:'auto_resolved', _lastSeen:now, status:'auto_resolved'}));
      arCount++;
    });

    var usedNums = {};
    merged.forEach(function(c){
      var prev = prevByKey[c._identityKey];
      if (prev && prev.number != null) {
        c.number = prev.number;
        usedNums[prev.number] = true;
      }
    });
    var nextNum = 1;
    merged.forEach(function(c){
      if (c.number != null) return;
      while (usedNums[nextNum]) nextNum++;
      c.number = nextNum;
      usedNums[nextNum] = true;
      nextNum++;
    });

    var newCount=0, persisting=0, autoResolved=0;
    merged.forEach(function(c){if(c._delta==='new')newCount++;else if(c._delta==='persisting')persisting++;else if(c._delta==='auto_resolved')autoResolved++;});
    // R3 follow-up: autoResolved used to report autoResolved+arOverflow --
    // now that overflow is preserved (not dropped), that double-counted:
    // a 205-prior-open-clash run with the 200-cap in effect would report
    // "205 auto-resolved" when only 200 actually flipped status and 5
    // stayed open (_delta:'auto_resolve_capped'). Report them separately;
    // autoResolvedTruncated already existed as this exact count, it just
    // wasn't the ONLY place it was reflected.
    return {clashes:merged, deltaSummary:{newCount:newCount,persisting:persisting,autoResolved:autoResolved,autoResolvedTruncated:arOverflow||undefined,notChecked:notChecked||undefined,ts:now}};
  }

  return Object.freeze({
    // v2 (CLAUDE.md Item 2): added options.coverage (run-scope awareness --
    // a prior clash outside this run's scope is preserved as 'not_checked'
    // rather than auto-resolved) and AUTO_RESOLVE_CAP overflow no longer
    // drops records -- they're preserved unchanged, only capped from
    // flipping to auto_resolved.
    contractVersion: 2,
    autoResolveCap: AUTO_RESOLVE_CAP,
    mergeDetectionResults: mergeDetectionResults
  });
}));
