"""Exercise the actual pure HTTP validator without requiring an HA installation."""
import ast
from copy import deepcopy
from pathlib import Path
import re
from typing import Any
import unittest

source = Path(__file__).resolve().parents[1] / "custom_components/ha3d_lab/http.py"
module = ast.parse(source.read_text(encoding="utf-8"))
names = {"_is_entity_id", "_is_number", "_is_valid_robot"}
functions = ast.Module(body=[node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
namespace = {"Any": Any, "_ENTITY_ID_RE": re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")}
exec(compile(functions, str(source), "exec"), namespace)
valid = namespace["_is_valid_robot"]


class RobotSchemaTests(unittest.TestCase):
    def setUp(self):
        self.robot = {"id": "test", "vacuum_entity": "vacuum.test", "position_entity": "sensor.position", "floor_plane": "xz", "floor_y": 0.6, "remote_pulse_ms": 1600, "remote_settle_ms": 6000, "calibration": {"points": [{"raw": [0, 0], "model": [1, 2]}, {"raw": [1000, 0], "model": [2, 2]}, {"raw": [0, 1000], "model": [1, 3]}]}}

    def test_new_points_and_planes(self):
        for plane in ("xz", "xy", "yz"):
            self.robot["floor_plane"] = plane
            self.assertTrue(valid(self.robot))

    def test_legacy_compatible(self):
        del self.robot["floor_plane"]
        self.robot["calibration"] = {"raw_a": [0, 0], "model_a": [1, 2], "raw_b": [1, 1], "model_b": [2, 3], "invert_y": True}
        self.assertTrue(valid(self.robot))

    def test_invalid_points_rejected(self):
        for bad in (None, "text", {}, [{"raw": [0], "model": [0, 1]}], [{"raw": [True, 0], "model": [0, 1]}], [{"raw": [float("nan"), 0], "model": [0, 1]}], [{"raw": [0, 1], "model": [0, float("inf")]}], [{"raw": [0, 1], "model": [0, 1], "extra": 1}]):
            robot = deepcopy(self.robot)
            robot["calibration"]["points"] = bad
            self.assertFalse(valid(robot), repr(bad))

    def test_limit(self):
        self.robot["calibration"]["points"] *= 17
        self.assertFalse(valid(self.robot))

    def test_invalid_plane(self):
        self.robot["floor_plane"] = "zz"
        self.assertFalse(valid(self.robot))

    def test_map_overlay_shared_config(self):
        self.robot["map_entity"] = "image.xiaomi_map"
        self.robot["map_overlay"] = {"visible": False, "x": 0.27715605, "z": -1.0158935, "y": 0.24, "scale": 0.05, "rotation": -89, "opacity": 0.8}
        self.assertTrue(valid(self.robot))

    def test_invalid_map_overlay_rejected(self):
        robot = deepcopy(self.robot)
        robot["map_overlay"] = {"visible": "no", "x": 0}
        self.assertFalse(valid(robot))
        robot = deepcopy(self.robot)
        robot["map_overlay"] = {"x": 0, "unexpected": 1}
        self.assertFalse(valid(robot))


if __name__ == "__main__":
    unittest.main()
