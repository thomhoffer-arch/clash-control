// ── ClashControl Addon: IFCSidecar Export ───────────────────────
// Exports loaded models as GLB + .ifcmeta + .ifcprops sidecar bundles.
// This lets users re-import models into ClashControl (or other BIM tools)
// without needing the original IFC/Revit source files.

(function() {
  'use strict';

  window._ccRegisterAddon({
    id: 'ifc-sidecar',
    name: 'IFCSidecar Export',
    description: 'Export loaded models as GLB + .ifcmeta + .ifcprops sidecar bundles for fast re-import.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',

    initState: {
      ifcSidecar: {
        exporting: false,
        progress: ''
      }
    },

    reducerCases: {
      'UPD_IFC_SIDECAR': function(s, a) {
        return Object.assign({}, s, {ifcSidecar: Object.assign({}, s.ifcSidecar, a.u)});
      }
    },

    init: function() {},
    destroy: function() {},

    panel: function(html, s, d) {
      var sc = s.ifcSidecar || {};
      var models = s.models || [];
      var hasModels = models.length > 0;

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{marginBottom:'.4rem',fontSize:'0.69rem',color:'var(--text-faint)'}}>
          Export each loaded model as a GLB + sidecar bundle for fast re-import without IFC parsing.
        </div>
        ${!hasModels && html`<div style=${{fontSize:'0.69rem',color:'var(--text-faint)',fontStyle:'italic'}}>No models loaded.</div>`}
        ${hasModels && html`<div style=${{display:'flex',flexDirection:'column',gap:'.4rem'}}>
          ${models.map(function(model) {
            var elCount = (model.elements || []).length;
            var meshCount = 0;
            (model.elements || []).forEach(function(el) { meshCount += (el.meshes || []).length; });
            return html`<div style=${{display:'flex',alignItems:'center',gap:'.4rem',flexWrap:'wrap'}}>
              <button onClick=${function(){ _exportModel(model, d); }}
                disabled=${sc.exporting}
                style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.72rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',
                  background:sc.exporting?'var(--bg-secondary)':'#059669',color:sc.exporting?'var(--text-secondary)':'#fff',
                  opacity:sc.exporting?0.6:1}}>
                Export</button>
              <span style=${{fontSize:'0.69rem'}}>${model.name || model.id} <span style=${{color:'var(--text-faint)'}}>(${elCount} elements, ${meshCount} meshes)</span></span>
            </div>`;
          })}
          ${models.length > 1 && html`<button onClick=${function(){ _exportAll(models, d); }}
            disabled=${sc.exporting}
            style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.72rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',
              background:sc.exporting?'var(--bg-secondary)':'#2563eb',color:sc.exporting?'var(--text-secondary)':'#fff',
              opacity:sc.exporting?0.6:1,alignSelf:'flex-start',marginTop:'.2rem'}}>
            Export All Models</button>`}
        </div>`}
        ${sc.progress && html`<div style=${{fontSize:'0.63rem',color:'var(--text-faint)',marginTop:'.3rem'}}>${sc.progress}</div>`}
      </div>`;
    }
  });

  // ── Export logic ───────────────────────────────────────────────

  function _exportAll(models, dispatch) {
    dispatch({t:'UPD_IFC_SIDECAR', u:{exporting:true, progress:'Preparing export...'}});
    var i = 0;
    function next() {
      if (i >= models.length) {
        dispatch({t:'UPD_IFC_SIDECAR', u:{exporting:false, progress:'All models exported.'}});
        setTimeout(function(){ dispatch({t:'UPD_IFC_SIDECAR', u:{progress:''}}); }, 3000);
        return;
      }
      var model = models[i];
      dispatch({t:'UPD_IFC_SIDECAR', u:{progress:'Exporting ' + (model.name || model.id) + ' (' + (i+1) + '/' + models.length + ')...'}});
      i++;
      // Small delay so UI updates
      setTimeout(function(){ _exportModel(model, dispatch, next); }, 50);
    }
    next();
  }

  function _exportModel(model, dispatch, onDone) {
    if (!onDone) {
      dispatch({t:'UPD_IFC_SIDECAR', u:{exporting:true, progress:'Exporting ' + (model.name || model.id) + '...'}});
    }

    var baseName = _sanitizeFilename(model.name || model.id || 'model');
    var elements = model.elements || [];

    // 1. Build .ifcprops
    var ifcprops = _buildIfcprops(elements);

    // 2. Build .ifcmeta
    var ifcmeta = _buildIfcmeta(elements, model);

    // 3. Export GLB via Three.js GLTFExporter
    _exportGLB(elements, baseName, function(glbBlob) {
      // Download all three files
      _downloadBlob(glbBlob, baseName + '.glb');

      var propsJson = JSON.stringify(ifcprops, null, 2);
      _downloadBlob(new Blob([propsJson], {type:'application/json'}), baseName + '.ifcprops');

      var metaJson = JSON.stringify(ifcmeta, null, 2);
      _downloadBlob(new Blob([metaJson], {type:'application/json'}), baseName + '.ifcmeta');

      if (onDone) {
        onDone();
      } else {
        dispatch({t:'UPD_IFC_SIDECAR', u:{exporting:false, progress:'Exported ' + baseName + ' (.glb + .ifcprops + .ifcmeta)'}});
        setTimeout(function(){ dispatch({t:'UPD_IFC_SIDECAR', u:{progress:''}}); }, 4000);
      }
    }, function(err) {
      console.error('[IFCSidecar] GLB export failed:', err);
      if (onDone) {
        onDone();
      } else {
        dispatch({t:'UPD_IFC_SIDECAR', u:{exporting:false, progress:'Export failed: ' + err}});
      }
    });
  }

  // ── .ifcprops builder ─────────────────────────────────────────

  function _buildIfcprops(elements) {
    var result = {elements: {}};

    elements.forEach(function(el) {
      var p = el.props || {};
      var gid = p.globalId;
      if (!gid) return;

      var entry = {
        expressId: el.expressId || 0,
        globalId: gid,
        category: p.ifcType || '',
        name: p.name || '',
        type: p.objectType || '',
        level: p.storey || '',
        description: p.description || '',
      };

      // Material — may be string or array
      if (p.material) {
        entry.materials = p.material;
      }

      // Quantities
      if (p.quantities && Object.keys(p.quantities).length > 0) {
        entry.quantities = p.quantities;
      }

      // Parameters / property sets
      if (p.psets && Object.keys(p.psets).length > 0) {
        entry.parameters = p.psets;
      }

      // Revit-specific
      if (p.revitId != null) entry.revitId = p.revitId;

      result.elements[gid] = entry;
    });

    return result;
  }

  // ── .ifcmeta builder ──────────────────────────────────────────

  function _buildIfcmeta(elements, model) {
    var result = {
      elements: {},
      storeys: [],
      storeyData: [],
      relatedPairs: {}
    };

    var storeySet = {};

    elements.forEach(function(el) {
      var p = el.props || {};
      var gid = p.globalId;
      if (!gid) return;

      var entry = {
        name: p.name || '',
        ifcType: p.ifcType || '',
      };

      if (p.objectType) entry.objectType = p.objectType;
      if (p.storey) {
        entry.storey = p.storey;
        storeySet[p.storey] = true;
      }
      if (p.material) entry.material = p.material;
      if (p.revitId != null) entry.revitId = p.revitId;
      if (p.quantities && Object.keys(p.quantities).length > 0) entry.quantities = p.quantities;
      if (p.psets && Object.keys(p.psets).length > 0) entry.psets = p.psets;
      if (p.phase) entry.phase = p.phase;
      if (p.workset) entry.workset = p.workset;
      if (p.designOption != null) entry.designOption = p.designOption;
      if (p.hostId) entry.hostId = p.hostId;
      if (p.hostRelationships && p.hostRelationships.length > 0) entry.hostRelationships = p.hostRelationships;
      if (p.layers && p.layers.length > 0) entry.layers = p.layers;
      if (p.flipState) entry.flipState = p.flipState;
      if (p.constraints) entry.constraints = p.constraints;

      result.elements[gid] = entry;
    });

    // Storeys — sorted by name
    result.storeys = Object.keys(storeySet).sort();

    // Storey data with elevation if available
    if (model.storeyData && model.storeyData.length > 0) {
      result.storeyData = model.storeyData;
    } else {
      result.storeyData = result.storeys.map(function(s) { return {name: s}; });
    }

    // Related pairs — preserve from model if available
    if (model.relatedPairs) {
      result.relatedPairs = model.relatedPairs;
    } else {
      // Build from host relationships
      elements.forEach(function(el) {
        var p = el.props || {};
        if (!p.globalId) return;
        // hostId → parent↔child pair
        if (p.hostId) {
          var pair = [p.globalId, p.hostId].sort().join(':');
          result.relatedPairs[pair] = true;
        }
        // hostRelationships → parent↔each child
        if (p.hostRelationships) {
          p.hostRelationships.forEach(function(childGid) {
            var pair = [p.globalId, childGid].sort().join(':');
            result.relatedPairs[pair] = true;
          });
        }
      });
    }

    return result;
  }

  // ── GLB export ────────────────────────────────────────────────

  function _exportGLB(elements, baseName, onSuccess, onError) {
    _ensureGLTFExporter(function() {
      var exportScene = new THREE.Scene();
      var meshCount = 0;

      elements.forEach(function(el) {
        var p = el.props || {};
        var gid = p.globalId || '';

        (el.meshes || []).forEach(function(mesh) {
          if (!mesh.geometry) return;
          var clone = mesh.clone();
          // Use original material if available (not ghost/highlight material)
          if (mesh._origMaterial) {
            clone.material = mesh._origMaterial.clone();
          }
          // Node name = GlobalId (the join key for sidecar loading)
          clone.name = gid;
          clone.userData.globalId = gid;
          clone.userData.expressId = el.expressId || 0;
          exportScene.add(clone);
          meshCount++;
        });
      });

      if (meshCount === 0) {
        onError('No meshes to export');
        return;
      }

      var exporter = new THREE.GLTFExporter();
      exporter.parse(exportScene, function(result) {
        var blob = new Blob([result], {type: 'application/octet-stream'});
        // Clean up cloned meshes
        exportScene.traverse(function(obj) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(function(m){ m.dispose(); });
            else obj.material.dispose();
          }
        });
        onSuccess(blob);
      }, function(err) {
        onError(err);
      }, {binary: true});
    });
  }

  var _gltfExporterLoaded = false;

  function _ensureGLTFExporter(cb) {
    if (_gltfExporterLoaded || (typeof THREE !== 'undefined' && THREE.GLTFExporter)) {
      _gltfExporterLoaded = true;
      cb();
      return;
    }
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/exporters/GLTFExporter.js';
    script.onload = function() { _gltfExporterLoaded = true; cb(); };
    script.onerror = function() { console.error('[IFCSidecar] Failed to load GLTFExporter'); };
    document.head.appendChild(script);
  }

  // ── Helpers ───────────────────────────────────────────────────

  function _downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function _sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/\s+/g, '_').substring(0, 80);
  }

})();
