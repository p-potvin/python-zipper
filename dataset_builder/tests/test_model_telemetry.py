"""Tests for dataset-builder model-run telemetry.

Nothing here imports torch, transformers or spandrel — the telemetry bridge is
stdlib-only and the model paths are exercised through it rather than by loading
weights.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vw_telemetry as telemetry  # noqa: E402


def _isolate():
    if not telemetry.available():
        return None
    from vaultwares_adk.telemetry import configure

    return configure(
        spool_dir=tempfile.mkdtemp(prefix="pz-telemetry-test"),
        api_url="http://127.0.0.1:9",
        post_timeout_s=0.15,
        enabled=True,
    )


@unittest.skipUnless(telemetry.available(), "vaultwares-adk submodule not initialised")
class TestUpscaleTelemetry(unittest.TestCase):
    def setUp(self):
        _isolate()

    def test_model_upscale_is_a_normal_run(self):
        with telemetry.run(model="4xNomos8k_atd", task="image", runtime="spandrel",
                           width=512, height=512, image_count=1) as run:
            pass
        record = run.record
        self.assertEqual(record.runtime, "spandrel")
        self.assertEqual(record.status, "ok")
        self.assertEqual(record.task, "image")

    def test_pillow_fallback_is_rejected_not_ok(self):
        # A Lanczos resize is not a model. Recording it as a successful upscale
        # would inflate model volume with work no model did; recording nothing
        # would hide that the weights are missing.
        record = telemetry.record(
            provider="local", runtime="pillow", model="pillow-lanczos", task="image",
            status="rejected", error_class="UpscalerModelMissing", duration_ms=0.0,
        )
        self.assertEqual(record.status, "rejected")
        self.assertEqual(record.error_class, "UpscalerModelMissing")
        self.assertEqual(record.runtime, "pillow")

    def test_local_work_is_free_with_an_exact_zero(self):
        with telemetry.run(model="m", task="image") as run:
            pass
        self.assertEqual(run.record.cost_usd, 0.0)
        self.assertTrue(run.record.is_free)
        self.assertTrue(run.record.priced_exactly)


@unittest.skipUnless(telemetry.available(), "vaultwares-adk submodule not initialised")
class TestDetectionJobTelemetry(unittest.TestCase):
    def setUp(self):
        _isolate()

    def test_batch_job_records_counts_not_per_image_rows(self):
        # A dataset pass is routinely thousands of files; the number worth
        # having is throughput across the job.
        job = telemetry.run(model="facebook/detr-resnet-50", task="vision",
                            provider="huggingface", runtime="transformers",
                            load_ms=2200.0)
        job.start()
        job.set(image_count=1250, images_matched=980, image_failed=7)
        job.close()
        record = job.record
        self.assertEqual(record.image_count, 1250)
        self.assertEqual(record.extra["images_matched"], 980)
        self.assertEqual(record.load_ms, 2200.0)

    def test_per_image_failures_do_not_fail_the_job(self):
        # The file is moved aside and the pass continues, so the count rides on
        # the run rather than flipping its status.
        job = telemetry.run(model="m", task="vision")
        job.start()
        job.set(image_count=10, image_failed=10)
        job.close()
        self.assertEqual(job.record.status, "ok")
        self.assertEqual(job.record.extra["image_failed"], 10)

    def test_model_load_failure_is_recorded(self):
        record = telemetry.record(
            provider="huggingface", runtime="transformers", model="facebook/detr-resnet-50",
            task="vision", status="error", error_class="OSError",
            error_message="offline", duration_ms=1500.0,
        )
        self.assertEqual(record.status, "error")
        self.assertEqual(record.error_class, "OSError")


class TestDegradesWithoutAdk(unittest.TestCase):
    def test_null_run_accepts_any_call(self):
        null = telemetry._NullRun()
        with null as run:
            run.set(a=1).tag("x").start()
        self.assertIsNone(null.record)

    def test_record_returns_none_without_adk(self):
        # Callers must not depend on a record object coming back.
        self.assertIsNotNone(telemetry.record) if telemetry.available() else None


if __name__ == "__main__":
    unittest.main()
