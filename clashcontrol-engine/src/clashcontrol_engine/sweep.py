"""
Broad phase: vectorized sweep-and-prune using numpy.

Filters element pairs by AABB overlap (expanded by clearance gap).
Eliminates 95%+ of pairs before expensive narrow-phase checks.
"""
import numpy as np


def sweep_and_prune(elements_a, elements_b, max_gap_m, rules):
    """
    Returns list of (idx_a, idx_b) candidate pairs whose AABBs overlap
    or are within max_gap_m clearance.
    """
    if not elements_a or not elements_b:
        return []

    # Build AABB arrays: (N, 6) for [min_x, min_y, min_z, max_x, max_y, max_z]
    bboxes_a = np.array([
        [*e['bbox_min'], *e['bbox_max']] for e in elements_a
    ], dtype=np.float64)
    bboxes_b = np.array([
        [*e['bbox_min'], *e['bbox_max']] for e in elements_b
    ], dtype=np.float64)

    # Expand A's bboxes by max_gap for clearance detection
    bboxes_a_exp = bboxes_a.copy()
    bboxes_a_exp[:, :3] -= max_gap_m
    bboxes_a_exp[:, 3:] += max_gap_m

    # Pick axis with highest variance for sweep
    centers_a = (bboxes_a_exp[:, :3] + bboxes_a_exp[:, 3:]) / 2.0
    centers_b = (bboxes_b[:, :3] + bboxes_b[:, 3:]) / 2.0
    all_centers = np.concatenate([centers_a, centers_b], axis=0)
    variances = np.var(all_centers, axis=0)
    sweep_axis = int(np.argmax(variances))

    # Sort by sweep axis min
    order_a = np.argsort(bboxes_a_exp[:, sweep_axis])
    order_b = np.argsort(bboxes_b[:, sweep_axis])

    exclude_self = rules.get('excludeSelf', False)
    ex_type_pairs = set()
    for p in rules.get('excludeTypePairs', []):
        ex_type_pairs.add(p)
        parts = p.split(':')
        if len(parts) == 2:
            ex_type_pairs.add(f"{parts[1]}:{parts[0]}")

    # Map for Y and Z axes
    ay = (sweep_axis + 1) % 3
    az = (sweep_axis + 2) % 3

    candidates = []
    nb = len(order_b)

    for ia in order_a:
        a = bboxes_a_exp[ia]
        a_max_sweep = a[3 + sweep_axis]
        a_min_y = a[ay]
        a_max_y = a[3 + ay]
        a_min_z = a[az]
        a_max_z = a[3 + az]

        for jj in range(nb):
            jb = order_b[jj]
            b = bboxes_b[jb]

            # Sweep axis: skip if b starts after a ends
            if b[sweep_axis] > a_max_sweep:
                break
            # Sweep axis: skip if b ends before a starts
            if b[3 + sweep_axis] < a[sweep_axis]:
                continue

            # Y-axis overlap
            if b[ay] > a_max_y or b[3 + ay] < a_min_y:
                continue
            # Z-axis overlap
            if b[az] > a_max_z or b[3 + az] < a_min_z:
                continue

            ea = elements_a[ia]
            eb = elements_b[jb]

            # Skip self-clash
            if exclude_self and ea['model_id'] == eb['model_id'] and ea['id'] == eb['id']:
                continue

            # Skip excluded type pairs
            if ex_type_pairs:
                tp = ':'.join(sorted([ea.get('ifcType', ''), eb.get('ifcType', '')]))
                if tp in ex_type_pairs:
                    continue

            candidates.append((ia, jb))

    return candidates
