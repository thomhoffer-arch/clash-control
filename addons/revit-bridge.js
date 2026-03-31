// ── ClashControl Addon: Revit Bridge ─────────────────────────────
// Part 1: Direct Connector — WebSocket live link to Revit plugin.
// Receives geometry + properties, converts to Three.js meshes.
// Supports model update (REPLACE_MODEL) on re-sync, linked models,
// and manual-only push of clashes back to Revit.

(function() {
  'use strict';

  // ── Direct Connector state ─────────────────────────────────────

  var _revitWs = null;
  var _revitBuf = null;
  var _revitReconnect = null;
  // Track which CC model ID corresponds to which Revit document name
  // so re-exports update the existing model instead of adding a duplicate.
  var _revitModelMap = {}; // {documentName_modelName: ccModelId}

  // ── WebSocket connection ───────────────────────────────────────

  function _revitDirectConnect(port, d) {
    if (_revitWs && _revitWs.readyState <= 1) { _revitWs.close(); }
    clearTimeout(_revitReconnect);
    var url = 'ws://localhost:' + (port || 19780);
    d({t:'BRIDGE_LOG', logType:'info', text:'Connecting to Revit at ' + url + '...'});
    d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false, progress:0}});
    try { _revitWs = new WebSocket(url); } catch(e) {
      d({t:'BRIDGE_LOG', logType:'error', text:'WebSocket error: ' + e.message});
      return;
    }
    _revitWs.binaryType = 'arraybuffer';

    _revitWs.onopen = function() {
      d({t:'UPD_REVIT_DIRECT', u:{connected:true}});
      d({t:'BRIDGE_LOG', logType:'info', text:'Connected to Revit plugin.'});
      _revitWs.send(JSON.stringify({type:'ping'}));
    };

    _revitWs.onclose = function() {
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      d({t:'BRIDGE_LOG', logType:'info', text:'Revit connection closed.'});
      _revitWs = null;
    };

    _revitWs.onerror = function() {
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      d({t:'BRIDGE_LOG', logType:'error', text:'Could not connect to Revit. Is the plugin running?'});
      _revitWs = null;
    };

    _revitWs.onmessage = function(ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch(e) { return; }
      _handleRevitMessage(msg, d);
    };
  }

  function _revitDirectDisconnect(d) {
    clearTimeout(_revitReconnect);
    if (_revitWs) { _revitWs.close(); _revitWs = null; }
    _revitBuf = null;
    d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false, progress:0, documentName:''}});
  }

  function _revitDirectExport(categories) {
    if (!_revitWs || _revitWs.readyState !== 1) return;
    _revitWs.send(JSON.stringify({type:'export', categories: categories || ['all']}));
  }

  // ── Base64 decode helpers ──────────────────────────────────────

  function _b64ToFloat32(b64) {
    var bin = atob(b64), n = bin.length, buf = new ArrayBuffer(n), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(buf);
  }
  function _b64ToUint32(b64) {
    var bin = atob(b64), n = bin.length, buf = new ArrayBuffer(n), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return new Uint32Array(buf);
  }

  // ── Convert Revit element to Three.js mesh ─────────────────────

  function _revitElementToMesh(el, nextId) {
    var meshes = [], box = new THREE.Box3();
    if (el.geometry && el.geometry.positions) {
      var positions = _b64ToFloat32(el.geometry.positions);
      var indices = _b64ToUint32(el.geometry.indices);
      var geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setIndex(new THREE.BufferAttribute(indices, 1));
      if (el.geometry.normals) {
        geom.setAttribute('normal', new THREE.BufferAttribute(_b64ToFloat32(el.geometry.normals), 3));
      } else {
        geom.computeVertexNormals();
      }
      geom.computeBoundingBox();
      var c = el.geometry.color || [0.65, 0.65, 0.65, 1.0];
      var mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(c[0], c[1], c[2]),
        opacity: c[3] != null ? c[3] : 1,
        transparent: c[3] != null && c[3] < 0.99,
        side: THREE.DoubleSide
      });
      var mesh = new THREE.Mesh(geom, mat);
      mesh.name = el.globalId || '';
      mesh._expressId = el.expressId || nextId;
      meshes.push(mesh);
      box.copy(geom.boundingBox);
    }
    var mats = el.materials;
    if (Array.isArray(mats)) mats = mats.join(', ');
    return {
      expressId: el.expressId || nextId,
      meshes: meshes,
      box: box,
      props: {
        globalId: el.globalId || '',
        ifcType: el.category || 'IfcBuildingElementProxy',
        name: el.name || '',
        description: el.description || '',
        objectType: el.type || '',
        storey: el.level || '',
        material: mats || '',
        quantities: el.quantities || {},
        psets: el.parameters || {},
        revitId: el.revitId || null,
        hostId: el.hostId || null,
        hostRelationships: el.hostRelationships || null
      }
    };
  }

  // ── Message handler ────────────────────────────────────────────

  function _handleRevitMessage(msg, d) {
    switch (msg.type) {
      case 'pong':
      case 'status':
        if (msg.documentName) d({t:'UPD_REVIT_DIRECT', u:{documentName:msg.documentName}});
        if (msg.connected != null) d({t:'UPD_REVIT_DIRECT', u:{connected:msg.connected}});
        break;

      case 'model-start':
        var isLink = !!msg.isLink;
        var modelLabel = (isLink ? '[Link] ' : '') + (msg.name || 'Revit Model');
        _revitBuf = {
          name: modelLabel,
          rawName: msg.name || 'Revit Model',
          isLink: isLink,
          elements:[], meshes:[],
          count: msg.elementCount || 0,
          received: 0
        };
        d({t:'UPD_REVIT_DIRECT', u:{loading:true, progress:0, elementCount:msg.elementCount||0}});
        d({t:'BRIDGE_LOG', logType:'pull', text:'Receiving ' + (isLink ? 'linked model' : 'model') + ' "' + msg.name + '" (' + (msg.elementCount||'?') + ' elements)...'});
        break;

      case 'element-batch':
        if (!_revitBuf) break;
        var nextId = _revitBuf.elements.length + 1;
        (msg.elements || []).forEach(function(el) {
          var converted = _revitElementToMesh(el, nextId++);
          _revitBuf.elements.push(converted);
          converted.meshes.forEach(function(m) { _revitBuf.meshes.push(m); });
        });
        _revitBuf.received += (msg.elements || []).length;
        var prog = _revitBuf.count > 0 ? _revitBuf.received / _revitBuf.count : 0;
        d({t:'UPD_REVIT_DIRECT', u:{progress: Math.min(prog, 0.99)}});
        break;

      case 'model-end':
        if (!_revitBuf) break;
        _finalizeModel(msg, d);
        break;

      case 'model-sync':
        // Revit project was synced — Connector sends a full re-export.
        // This is identical to model-end but explicitly signals "update existing".
        if (!_revitBuf) break;
        _finalizeModel(msg, d);
        break;

      case 'element-update':
        _handleElementUpdate(msg, d);
        break;

      case 'error':
        d({t:'BRIDGE_LOG', logType:'error', text:'Revit: ' + (msg.message || 'Unknown error')});
        break;
    }
  }

  // ── Finalize a received model (add or replace) ─────────────────

  function _finalizeModel(msg, d) {
    var storeys = msg.storeys || [];
    var storeyData = msg.storeyData || [];
    var relatedPairs = msg.relatedPairs || {};

    // Derive storeys from elements if not provided
    if (storeys.length === 0) {
      var seen = {};
      _revitBuf.elements.forEach(function(el) {
        if (el.props.storey && !seen[el.props.storey]) { storeys.push(el.props.storey); seen[el.props.storey] = true; }
      });
    }

    // Derive relatedPairs from hostId/hostRelationships if not provided
    if (Object.keys(relatedPairs).length === 0) {
      _revitBuf.elements.forEach(function(el) {
        if (el.props.hostId) {
          relatedPairs[el.props.hostId + ':' + el.props.globalId] = true;
        }
        if (el.props.hostRelationships) {
          el.props.hostRelationships.forEach(function(childGid) {
            relatedPairs[el.props.globalId + ':' + childGid] = true;
          });
        }
      });
    }

    var detectDiscipline = window._ccDetectDiscipline || function() { return 'architectural'; };
    var DISC = window._ccDISC || [{id:'architectural', c:'#60a5fa'}];
    var uid = window._ccUid || function() { return Math.random().toString(36).slice(2,10).toUpperCase(); };

    var disc = detectDiscipline(_revitBuf.elements);
    var dObj = DISC.find(function(x){return x.id===disc;});
    var col = dObj ? dObj.c : DISC[0].c;

    // Check if a model with this name already exists (update, don't duplicate)
    var state = window._ccLatestState;
    var mapKey = _revitBuf.rawName;
    var existingId = _revitModelMap[mapKey];
    var existingModel = null;

    if (existingId && state) {
      existingModel = state.models.find(function(m) { return m.id === existingId; });
    }

    // Also search by name + source if map doesn't have it
    if (!existingModel && state) {
      existingModel = state.models.find(function(m) {
        return m.name === _revitBuf.name && m.stats && m.stats.source === 'revit-direct';
      });
    }

    if (existingModel) {
      // REPLACE existing model — keeps same ID, same slot, preserves clash references
      var modelData = {
        id: existingModel.id,
        name: _revitBuf.name,
        discipline: existingModel.discipline || disc,
        color: existingModel.color || col,
        visible: existingModel.visible !== false,
        tag: existingModel.tag || '',
        _version: (existingModel._version || 1) + 1,
        meshes: _revitBuf.meshes,
        elements: _revitBuf.elements,
        storeys: storeys,
        storeyData: storeyData,
        spatialHierarchy: {},
        relatedPairs: relatedPairs,
        stats: {elementCount:_revitBuf.elements.length, source:'revit-direct', lastSync:Date.now()}
      };
      window._ccDispatch({t:'REPLACE_MODEL', id:existingModel.id, v:modelData});
      _revitModelMap[mapKey] = existingModel.id;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Updated model "' + _revitBuf.rawName + '": ' + _revitBuf.elements.length + ' elements (v' + modelData._version + ').'});
    } else {
      // ADD new model
      var modelId = uid();
      var modelData2 = {
        id: modelId, name: _revitBuf.name, discipline:disc, color:col, visible:true, _version:1,
        meshes:_revitBuf.meshes, elements:_revitBuf.elements, storeys:storeys,
        storeyData:storeyData, spatialHierarchy:{}, relatedPairs:relatedPairs,
        stats:{elementCount:_revitBuf.elements.length, source:'revit-direct', lastSync:Date.now()}
      };
      window._ccDispatch({t:'ADD_MODEL', v:modelData2});
      _revitModelMap[mapKey] = modelId;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Model "' + _revitBuf.rawName + '" loaded: ' + _revitBuf.elements.length + ' elements.'});
    }

    d({t:'UPD_REVIT_DIRECT', u:{loading:false, progress:1}});
    _revitBuf = null;
  }

  // ── Incremental element updates ────────────────────────────────

  function _handleElementUpdate(msg, d) {
    var state = window._ccLatestState;
    if (!state) return;

    if (msg.action === 'deleted' && msg.globalIds) {
      // Remove elements from the model that contains them
      var removedCount = 0;
      state.models.forEach(function(m) {
        if (!m.stats || m.stats.source !== 'revit-direct') return;
        var before = m.elements.length;
        var gids = {};
        msg.globalIds.forEach(function(gid) { gids[gid] = true; });
        var filtered = m.elements.filter(function(el) { return !gids[el.props.globalId]; });
        if (filtered.length < before) {
          removedCount += (before - filtered.length);
          // Remove meshes from scene
          m.elements.forEach(function(el) {
            if (gids[el.props.globalId]) {
              el.meshes.forEach(function(mesh) {
                if (mesh.parent) mesh.parent.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) mesh.material.dispose();
              });
            }
          });
          m.elements = filtered;
          m.meshes = [];
          filtered.forEach(function(el) { el.meshes.forEach(function(mesh) { m.meshes.push(mesh); }); });
        }
      });
      d({t:'BRIDGE_LOG', logType:'pull', text:removedCount + ' elements deleted from Revit.'});
      if (window.invalidate) window.invalidate(2);

    } else if (msg.action === 'modified' && msg.elements) {
      // Replace meshes for modified elements
      var updatedCount = 0;
      msg.elements.forEach(function(elData) {
        var gid = elData.globalId;
        if (!gid) return;
        state.models.forEach(function(m) {
          if (!m.stats || m.stats.source !== 'revit-direct') return;
          var idx = m.elements.findIndex(function(el) { return el.props.globalId === gid; });
          if (idx === -1) return;
          // Dispose old meshes
          var oldEl = m.elements[idx];
          oldEl.meshes.forEach(function(mesh) {
            if (mesh.parent) mesh.parent.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
          });
          // Create new element
          var newEl = _revitElementToMesh(elData, oldEl.expressId);
          m.elements[idx] = newEl;
          // Rebuild mesh list
          m.meshes = [];
          m.elements.forEach(function(el) { el.meshes.forEach(function(mesh) { m.meshes.push(mesh); }); });
          // Add new meshes to scene
          var S = window._ccState3d;
          if (S && S.modelGroup) {
            newEl.meshes.forEach(function(mesh) { S.modelGroup.add(mesh); });
          }
          updatedCount++;
        });
      });
      d({t:'BRIDGE_LOG', logType:'pull', text:updatedCount + ' elements updated from Revit.'});
      if (window.invalidate) window.invalidate(2);
    }
  }

  // ── Push clashes to Revit (manual only) ────────────────────────

  function _revitDirectPushClashes(s, d) {
    if (!_revitWs || _revitWs.readyState !== 1) {
      d({t:'BRIDGE_LOG', logType:'error', text:'Not connected to Revit.'});
      return;
    }
    var clashData = s.clashes.filter(function(c) {
      return c.status === 'open' || c.status === 'confirmed' || c.status === 'in_progress';
    }).map(function(c) {
      var elA = null, elB = null;
      s.models.forEach(function(m) {
        if (!m.elements) return;
        m.elements.forEach(function(el) {
          if (el.expressId === c.elemA) elA = el;
          if (el.expressId === c.elemB) elB = el;
        });
      });
      return {
        id: c.id,
        status: c.status,
        priority: c.priority || 'normal',
        type: c.type || 'hard',
        point: c.point ? {x:c.point.x, y:c.point.y, z:c.point.z} : null,
        elementA: elA ? {globalId:elA.props.globalId, name:elA.props.name, ifcType:elA.props.ifcType, revitId:elA.props.revitId||null} : null,
        elementB: elB ? {globalId:elB.props.globalId, name:elB.props.name, ifcType:elB.props.ifcType, revitId:elB.props.revitId||null} : null
      };
    });
    var issueData = s.issues.filter(function(i) {
      return i.status === 'open' || i.status === 'in_progress';
    }).map(function(i) {
      return {
        id: i.id,
        title: i.title,
        status: i.status,
        priority: i.priority || 'normal',
        description: i.description || '',
        elementIds: (i.elementIds || []).map(function(eid) {
          var found = null;
          s.models.forEach(function(m) { if (m.elements) m.elements.forEach(function(el) { if (el.expressId === eid) found = el; }); });
          return found ? {globalId:found.props.globalId, name:found.props.name, revitId:found.props.revitId||null} : null;
        }).filter(Boolean)
      };
    });
    _revitWs.send(JSON.stringify({
      type:'push-clashes',
      clashes: clashData,
      issues: issueData
    }));
    d({t:'UPD_REVIT_DIRECT', u:{lastPush:Date.now()}});
    d({t:'BRIDGE_LOG', logType:'push', text:'Pushed ' + clashData.length + ' clashes + ' + issueData.length + ' issues to Revit.'});
  }

  // ── Port persistence ───────────────────────────────────────────

  function _saveDirectPort(port) {
    try { localStorage.setItem('cc_revit_direct_port', String(port)); } catch(e) {}
  }
  function _loadDirectPort() {
    try { return parseInt(localStorage.getItem('cc_revit_direct_port'), 10) || 19780; } catch(e) { return 19780; }
  }

  // ── Expose globally ────────────────────────────────────────────

  window._revitDirectConnect = _revitDirectConnect;
  window._revitDirectDisconnect = _revitDirectDisconnect;
  window._revitDirectExport = _revitDirectExport;
  window._revitDirectPushClashes = _revitDirectPushClashes;
  window._saveDirectPort = _saveDirectPort;
  window._loadDirectPort = _loadDirectPort;
  window._revitGetWs = function() { return _revitWs; };

  // ── Register addon ─────────────────────────────────────────────

  window._ccRegisterAddon({
    id: 'revit-bridge',
    name: 'Revit Bridge',
    description: 'Live link to Autodesk Revit via WebSocket. Pull geometry, push clashes. Supports linked models and incremental sync.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',

    initState: {
      revitBridge: {
        provider: '',
        apiKey: '',
        mcpHost: 'localhost',
        mcpPort: 8080,
        connected: false,
        syncing: false,
        lastSync: null,
        log: []
      },
      showRevitBridge: false,
      revitDirect: {
        port: 19780,
        connected: false,
        documentName: '',
        loading: false,
        progress: 0,
        elementCount: 0,
        lastPush: null
      }
    },

    reducerCases: {
      'UPD_BRIDGE': function(s, a) {
        return Object.assign({}, s, {revitBridge: Object.assign({}, s.revitBridge, a.u)});
      },
      'BRIDGE_LOG': function(s, a) {
        return Object.assign({}, s, {revitBridge: Object.assign({}, s.revitBridge, {
          log: s.revitBridge.log.concat([{ts:Date.now(), type:a.logType||'info', text:a.text}]).slice(-100)
        })});
      },
      'CLEAR_BRIDGE_LOG': function(s) {
        return Object.assign({}, s, {revitBridge: Object.assign({}, s.revitBridge, {log:[]})});
      },
      'REVIT_BRIDGE': function(s, a) {
        return Object.assign({}, s, {showRevitBridge: a.v});
      },
      'UPD_REVIT_DIRECT': function(s, a) {
        return Object.assign({}, s, {revitDirect: Object.assign({}, s.revitDirect, a.u)});
      }
    },

    init: function(dispatch, getState) {
      // Nothing to auto-start — user connects manually
    },

    destroy: function() {
      if (_revitWs) { _revitWs.close(); _revitWs = null; }
      clearTimeout(_revitReconnect);
      _revitBuf = null;
    }
  });
})();
