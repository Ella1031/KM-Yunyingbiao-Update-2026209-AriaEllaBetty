#!/usr/bin/env python3

import importlib.util
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


run_state = load_module("run_state", SCRIPT_DIR / "run_state.py")
build_full_refresh = load_module("build_full_refresh", SCRIPT_DIR / "build_full_refresh.py")


def write_xlsx(path: Path, value: str) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", f"<Types>{value}</Types>")


class RunStateTests(unittest.TestCase):
    def test_validated_source_and_stage_remain_reusable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.xlsx"
            output = root / "stage.xlsx"
            state_file = root / "run-state.json"
            write_xlsx(source, "source")
            write_xlsx(output, "stage")
            state = run_state.load_state(state_file, root)
            state["freshness"] = {"bi": 100.0, "erp": 200.0}
            run_state.record_source(state, "bi", source, "bi", "validated", {"status": "ok"})
            run_state.set_stage(state, "bi_processing", "complete", [output], {"status": "ok"})
            run_state.save_state(state_file, state)
            resumed = run_state.load_state(state_file)
            self.assertTrue(run_state.fingerprint_matches(resumed["sources"]["bi"]))
            self.assertTrue(run_state.stage_reusable(resumed, "bi_processing", [output]))
            self.assertEqual(resumed["freshness"], {"bi": 100.0, "erp": 200.0})

    def test_changed_source_is_not_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.xlsx"
            write_xlsx(source, "first")
            state = run_state.new_state(root)
            run_state.record_source(state, "tracking", source, "erp", "validated")
            write_xlsx(source, "changed")
            self.assertFalse(run_state.fingerprint_matches(state["sources"]["tracking"]))

    def test_safe_delivery_backs_up_before_atomic_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate.xlsx"
            destination = root / "operations.xlsx"
            write_xlsx(candidate, "new")
            write_xlsx(destination, "old")
            result = build_full_refresh.safe_deliver(candidate, destination, True, root)
            self.assertTrue(Path(result["backup"]).is_file())
            self.assertTrue(build_full_refresh.same_file_content(candidate, destination))
            self.assertNotEqual(run_state.sha256(Path(result["backup"])), run_state.sha256(destination))

    def test_old_source_validation_versions_are_revalidated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {
                name: root / f"{name}.xlsx"
                for name in ("workbook", "tracking", "products", "platform", "sales", "bi")
            }
            for name, path in paths.items():
                write_xlsx(path, name)

            state_file = root / "run-state.json"
            state = run_state.load_state(state_file, root)
            for name in ("tracking", "products", "platform", "sales"):
                run_state.record_source(state, name, paths[name], "erp", "validated")
            run_state.record_source(state, "bi", paths["bi"], "bi", "validated")
            run_state.set_stage(
                state,
                "erp_sources_validation",
                "complete",
                [paths[name] for name in ("tracking", "products", "platform", "sales")],
                {"exports": {}},
            )
            run_state.set_stage(
                state,
                "bi_source_validation",
                "complete",
                [paths["bi"]],
                {"status": "ok"},
            )

            args = SimpleNamespace(
                workbook=paths["workbook"],
                tracking=paths["tracking"],
                products=paths["products"],
                platform=paths["platform"],
                sales=paths["sales"],
                bi=paths["bi"],
                today=__import__("datetime").date(2026, 10, 28),
            )
            erp_result = {"exports": {name: {} for name in ("tracking", "products", "platform", "sales")}}
            bi_result = {"status": "ok"}
            with mock.patch.object(build_full_refresh, "run_json", side_effect=[erp_result, bi_result]) as runner:
                result = build_full_refresh.validate_sources(args, state, state_file, 100.0, 200.0)

            self.assertEqual(runner.call_count, 2)
            self.assertEqual(result["reused"], {"erp": False, "bi": False})
            self.assertEqual(
                state["stages"]["erp_sources_validation"]["result"]["validationVersion"],
                build_full_refresh.ERP_SOURCE_VALIDATION_VERSION,
            )
            self.assertEqual(
                state["stages"]["bi_source_validation"]["result"]["validationVersion"],
                build_full_refresh.BI_SOURCE_VALIDATION_VERSION,
            )


if __name__ == "__main__":
    unittest.main()
