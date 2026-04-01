"""Tests for the clash detection engine."""
import numpy as np
import pytest

from clashcontrol_engine.intersection import (
    tri_tri_intersect,
    build_bvh,
    meshes_intersect,
    mesh_min_distance,
)
from clashcontrol_engine.sweep import sweep_and_prune
from clashcontrol_engine.engine import detect_clashes


# ── Triangle-triangle intersection ────────────────────────────────

def test_intersecting_triangles():
    """Two triangles that clearly intersect."""
    tri_a = np.array([
        [-1, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
    ], dtype=np.float64)
    tri_b = np.array([
        [0, 0.5, -1],
        [0, 0.5, 1],
        [0, -0.5, 0],
    ], dtype=np.float64)
    result = tri_tri_intersect(tri_a, tri_b)
    assert result is not None
    midpoint, depth = result
    assert depth > 0


def test_non_intersecting_triangles():
    """Two triangles that are far apart."""
    tri_a = np.array([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
    ], dtype=np.float64)
    tri_b = np.array([
        [10, 10, 10],
        [11, 10, 10],
        [10, 11, 10],
    ], dtype=np.float64)
    result = tri_tri_intersect(tri_a, tri_b)
    assert result is None


def test_coplanar_non_overlapping():
    """Two triangles in the same plane but not overlapping."""
    tri_a = np.array([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
    ], dtype=np.float64)
    tri_b = np.array([
        [5, 5, 0],
        [6, 5, 0],
        [5, 6, 0],
    ], dtype=np.float64)
    result = tri_tri_intersect(tri_a, tri_b)
    assert result is None


def test_degenerate_triangle():
    """A degenerate (zero-area) triangle should return None."""
    tri_a = np.array([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],  # collinear
    ], dtype=np.float64)
    tri_b = np.array([
        [0, -1, -1],
        [0, 1, -1],
        [0, 0, 1],
    ], dtype=np.float64)
    result = tri_tri_intersect(tri_a, tri_b)
    assert result is None


# ── BVH ───────────────────────────────────────────────────────────

def test_build_bvh_empty():
    tris = np.empty((0, 3, 3), dtype=np.float64)
    root, sorted_tris = build_bvh(tris)
    assert root is None


def test_build_bvh_single():
    tris = np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]], dtype=np.float64)
    root, sorted_tris = build_bvh(tris)
    assert root is not None
    assert len(sorted_tris) == 1


# ── Mesh intersection ─────────────────────────────────────────────

def _make_box(center, half_size):
    """Create a simple box mesh (8 verts, 12 triangles)."""
    cx, cy, cz = center
    h = half_size
    verts = np.array([
        [cx-h, cy-h, cz-h], [cx+h, cy-h, cz-h],
        [cx+h, cy+h, cz-h], [cx-h, cy+h, cz-h],
        [cx-h, cy-h, cz+h], [cx+h, cy-h, cz+h],
        [cx+h, cy+h, cz+h], [cx-h, cy+h, cz+h],
    ], dtype=np.float32)
    faces = np.array([
        [0,1,2], [0,2,3],  # front
        [4,6,5], [4,7,6],  # back
        [0,4,5], [0,5,1],  # bottom
        [2,6,7], [2,7,3],  # top
        [0,7,4], [0,3,7],  # left
        [1,5,6], [1,6,2],  # right
    ], dtype=np.int32)
    return verts, faces


def test_overlapping_boxes():
    """Two overlapping boxes should produce a hard clash."""
    verts_a, faces_a = _make_box([0, 0, 0], 1.0)
    verts_b, faces_b = _make_box([0.5, 0, 0], 1.0)
    result = meshes_intersect(verts_a, faces_a, verts_b, faces_b)
    assert result is not None
    point, depth = result
    assert depth > 0


def test_separated_boxes():
    """Two separated boxes should not intersect."""
    verts_a, faces_a = _make_box([0, 0, 0], 0.5)
    verts_b, faces_b = _make_box([5, 5, 5], 0.5)
    result = meshes_intersect(verts_a, faces_a, verts_b, faces_b)
    assert result is None


# ── Min distance ──────────────────────────────────────────────────

def test_min_distance_close():
    """Two nearby vertex sets within threshold."""
    verts_a = np.array([[0, 0, 0], [1, 0, 0]], dtype=np.float32)
    verts_b = np.array([[0.1, 0, 0], [1.1, 0, 0]], dtype=np.float32)
    result = mesh_min_distance(verts_a, verts_b, threshold_m=0.5)
    assert result is not None
    dist, midpoint = result
    assert dist < 0.5


def test_min_distance_far():
    """Two far vertex sets beyond threshold."""
    verts_a = np.array([[0, 0, 0]], dtype=np.float32)
    verts_b = np.array([[10, 10, 10]], dtype=np.float32)
    result = mesh_min_distance(verts_a, verts_b, threshold_m=0.5)
    assert result is None


# ── Sweep-and-prune ───────────────────────────────────────────────

def test_sweep_overlapping():
    elements_a = [{'id': 1, 'model_id': 'A', 'ifcType': 'IfcWall',
                   'bbox_min': [0, 0, 0], 'bbox_max': [2, 2, 2]}]
    elements_b = [{'id': 2, 'model_id': 'B', 'ifcType': 'IfcDuct',
                   'bbox_min': [1, 1, 1], 'bbox_max': [3, 3, 3]}]
    pairs = sweep_and_prune(elements_a, elements_b, 0.0, {})
    assert len(pairs) == 1


def test_sweep_separated():
    elements_a = [{'id': 1, 'model_id': 'A', 'ifcType': 'IfcWall',
                   'bbox_min': [0, 0, 0], 'bbox_max': [1, 1, 1]}]
    elements_b = [{'id': 2, 'model_id': 'B', 'ifcType': 'IfcDuct',
                   'bbox_min': [5, 5, 5], 'bbox_max': [6, 6, 6]}]
    pairs = sweep_and_prune(elements_a, elements_b, 0.0, {})
    assert len(pairs) == 0


def test_sweep_with_gap():
    """Elements within clearance gap should be candidates."""
    elements_a = [{'id': 1, 'model_id': 'A', 'ifcType': 'IfcWall',
                   'bbox_min': [0, 0, 0], 'bbox_max': [1, 1, 1]}]
    elements_b = [{'id': 2, 'model_id': 'B', 'ifcType': 'IfcDuct',
                   'bbox_min': [1.05, 0, 0], 'bbox_max': [2, 1, 1]}]
    # Without gap: no overlap
    pairs = sweep_and_prune(elements_a, elements_b, 0.0, {})
    assert len(pairs) == 0
    # With gap: should match
    pairs = sweep_and_prune(elements_a, elements_b, 0.1, {})
    assert len(pairs) == 1


# ── Full engine ───────────────────────────────────────────────────

def test_detect_clashes_end_to_end():
    """End-to-end test with two overlapping box elements."""
    verts_a, faces_a = _make_box([0, 0, 0], 1.0)
    verts_b, faces_b = _make_box([0.5, 0, 0], 1.0)

    payload = {
        'elements': [
            {
                'id': 1,
                'modelId': 'model1',
                'ifcType': 'IfcWall',
                'name': 'Wall A',
                'storey': 'Level 1',
                'discipline': 'architectural',
                'vertices': verts_a.flatten().tolist(),
                'indices': faces_a.flatten().tolist(),
            },
            {
                'id': 2,
                'modelId': 'model1',
                'ifcType': 'IfcDuct',
                'name': 'Duct B',
                'storey': 'Level 1',
                'discipline': 'mep',
                'vertices': verts_b.flatten().tolist(),
                'indices': faces_b.flatten().tolist(),
            },
        ],
        'rules': {
            'modelA': 'all',
            'modelB': 'all',
            'maxGap': 0,
            'mode': 'hard',
        },
    }

    result = detect_clashes(payload)
    assert 'clashes' in result
    assert 'stats' in result
    assert result['stats']['elementCount'] == 2
    assert result['stats']['candidatePairs'] >= 1
    # Should find at least one clash between overlapping boxes
    assert len(result['clashes']) >= 1

    clash = result['clashes'][0]
    assert 'id' in clash
    assert 'elementA' in clash
    assert 'elementB' in clash
    assert 'point' in clash
    assert clash['type'] == 'hard'


def test_detect_clashes_empty():
    """Empty payload should return empty results."""
    result = detect_clashes({'elements': [], 'rules': {}})
    assert result['clashes'] == []
    assert result['stats']['elementCount'] == 0
