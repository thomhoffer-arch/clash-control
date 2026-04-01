"""
Core clash detection engine.

Orchestrates broad phase (sweep-and-prune) and narrow phase (BVH + Möller)
across multiple CPU cores using ProcessPoolExecutor.
"""
import multiprocessing
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np

from .sweep import sweep_and_prune
from .intersection import meshes_intersect, mesh_min_distance


def _parse_elements(payload):
    """
    Parse the elements array from the browser addon into internal format.

    The addon sends flat vertex/index arrays (not base64), with fields:
    id, modelId, ifcType, name, storey, discipline, vertices, indices
    """
    elements = []
    mesh_cache = {}

    for elem in payload.get('elements', []):
        verts_flat = elem.get('vertices', [])
        idxs_flat = elem.get('indices', [])

        if not verts_flat or not idxs_flat:
            continue

        verts = np.array(verts_flat, dtype=np.float32).reshape(-1, 3)
        faces = np.array(idxs_flat, dtype=np.int32).reshape(-1, 3)

        if len(verts) < 3 or len(faces) < 1:
            continue

        bbox_min = verts.min(axis=0).tolist()
        bbox_max = verts.max(axis=0).tolist()

        eid = elem.get('id', 0)
        parsed = {
            'id': eid,
            'model_id': elem.get('modelId', ''),
            'ifcType': elem.get('ifcType', ''),
            'name': elem.get('name', ''),
            'storey': elem.get('storey', ''),
            'discipline': elem.get('discipline', 'other'),
            'bbox_min': bbox_min,
            'bbox_max': bbox_max,
        }

        mesh_cache[eid] = {
            'vertices': verts,
            'faces': faces,
        }

        elements.append(parsed)

    return elements, mesh_cache


def _check_pair(args):
    """Worker function for parallel execution (runs in subprocess)."""
    verts_a, faces_a, verts_b, faces_b, elem_a, elem_b, max_gap_m, check_hard = args

    # Hard clash: exact triangle-triangle intersection
    if check_hard:
        result = meshes_intersect(verts_a, faces_a, verts_b, faces_b)
        if result is not None:
            centroid, depth = result
            return {
                'elementA': elem_a['id'],
                'elementB': elem_b['id'],
                'point': centroid.tolist(),
                'distance': -round(depth * 1000),  # mm, negative = penetration
                'volume': float(depth * 0.001),  # rough estimate
                'type': 'hard',
            }

    # Soft clash: clearance distance check
    if max_gap_m > 0:
        result = mesh_min_distance(verts_a, verts_b, max_gap_m)
        if result is not None:
            dist_m, midpoint = result
            return {
                'elementA': elem_a['id'],
                'elementB': elem_b['id'],
                'point': midpoint.tolist(),
                'distance': round(dist_m * 1000),  # mm, positive = gap
                'volume': 0,
                'type': 'clearance',
            }

    return None


def _bbox_mm(bmin, bmax):
    return {
        'dx': round((bmax[0] - bmin[0]) * 1000),
        'dy': round((bmax[1] - bmin[1]) * 1000),
        'dz': round((bmax[2] - bmin[2]) * 1000),
    }


def detect_clashes(payload, on_progress=None):
    """
    Main entry point.

    payload: dict with 'elements' and 'rules' from the browser addon.
    on_progress: callback(done, total) for progress reporting.

    Returns dict with 'clashes' list and 'stats'.
    """
    t0 = time.time()

    rules = payload.get('rules', {})
    max_gap_m = rules.get('maxGap', 0) / 1000.0
    check_hard = rules.get('mode', 'hard') != 'soft'
    num_workers = max(1, multiprocessing.cpu_count() - 1)

    # 1. Parse elements
    all_elements, mesh_cache = _parse_elements(payload)

    if not all_elements:
        return {'clashes': [], 'stats': _stats(0, 0, 0, t0, num_workers)}

    # 2. Determine model groups
    model_a = rules.get('modelA', 'all')
    model_b = rules.get('modelB', 'all')

    if model_a == 'all':
        elements_a = all_elements
    else:
        elements_a = [e for e in all_elements if e['model_id'] == model_a]

    if model_b == 'all':
        elements_b = all_elements
    else:
        elements_b = [e for e in all_elements if e['model_id'] == model_b]

    # 3. Broad phase
    candidates = sweep_and_prune(elements_a, elements_b, max_gap_m, rules)

    if not candidates:
        return {'clashes': [], 'stats': _stats(len(all_elements), 0, 0, t0, num_workers)}

    # 4. Build task list
    tasks = []
    for ia, ib in candidates:
        ea = elements_a[ia]
        eb = elements_b[ib]
        ma = mesh_cache.get(ea['id'])
        mb = mesh_cache.get(eb['id'])
        if ma is None or mb is None:
            continue
        tasks.append((
            ma['vertices'], ma['faces'],
            mb['vertices'], mb['faces'],
            ea, eb, max_gap_m, check_hard,
        ))

    # 5. Parallel narrow phase
    clashes = []
    done_count = 0
    total = len(tasks)

    if total <= 4:
        # Too few tasks for multiprocessing overhead
        for task in tasks:
            done_count += 1
            result = _check_pair(task)
            if result is not None:
                clashes.append(result)
            if on_progress:
                on_progress(done_count, total)
    else:
        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            futures = {executor.submit(_check_pair, t): t for t in tasks}
            for future in as_completed(futures):
                done_count += 1
                if on_progress and done_count % max(1, total // 100) == 0:
                    on_progress(done_count, total)
                try:
                    result = future.result()
                    if result is not None:
                        clashes.append(result)
                except Exception:
                    pass  # Skip failed pairs (degenerate meshes, etc.)

    # 6. Add IDs
    for clash in clashes:
        clash['id'] = str(uuid.uuid4())[:8].upper()

    return {
        'clashes': clashes,
        'stats': _stats(len(all_elements), len(candidates), len(clashes), t0, num_workers),
    }


def _stats(element_count, candidate_pairs, clash_count, t0, threads):
    return {
        'elementCount': element_count,
        'candidatePairs': candidate_pairs,
        'clashCount': clash_count,
        'duration_ms': round((time.time() - t0) * 1000),
        'threads': threads,
    }
