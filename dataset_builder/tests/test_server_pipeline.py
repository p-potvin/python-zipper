import io
import os
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

import dataset_builder.server as server


def _png_bytes(size=(4, 3), color=(30, 80, 120)):
    image = Image.new("RGB", size, color)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


class ServerPipelineTests(unittest.TestCase):
    def test_upscaler_models_put_nomos_model_before_pillow_fallback(self):
        models = server.get_available_upscale_models()

        self.assertGreaterEqual(len(models), 2)
        self.assertEqual(models[0]["name"], "4xNomos8k_atd")
        self.assertEqual(models[0]["kind"], "spandrel")
        self.assertEqual(models[1]["name"], "pillow-lanczos")
        self.assertEqual(models[1]["kind"], "pillow")

    def test_local_job_registry_tracks_started_and_completed_jobs(self):
        with patch.object(server, "JOBS", {}):
            job_id = server.create_job(
                "https://example.test/gallery",
                ["https://cdn.example.test/a.png", "https://cdn.example.test/b.png"],
                5,
                True,
                "4xNomos8k_atd",
            )
            server.update_job(job_id, status="running", processed_links=1, images_count=1)
            server.complete_job(job_id, archives=["gallery_001.zip"], rclone_complete=True)

            snapshot = server.get_jobs_snapshot()

        self.assertIn(job_id, snapshot)
        self.assertEqual(snapshot[job_id]["status"], "completed")
        self.assertEqual(snapshot[job_id]["processed_links"], 1)
        self.assertEqual(snapshot[job_id]["total_links"], 2)
        self.assertEqual(snapshot[job_id]["archives"], ["gallery_001.zip"])
        self.assertTrue(snapshot[job_id]["rclone_complete"])

    def test_download_and_zip_images_upscales_image_and_hands_archive_to_rclone(self):
        with TemporaryDirectory() as temp_dir:
            handed_off = []
            handler = object.__new__(server.ScraperHandler)

            with (
                patch.object(server, "DEST_DIR", temp_dir),
                patch.object(server.scraper, "download_image", lambda _url, _headers: _png_bytes()),
                patch.object(server, "handoff_to_rclone", lambda path: handed_off.append(Path(path))),
            ):
                handler._download_and_zip_images(
                    "sample",
                    "https://example.test/gallery",
                    ["https://cdn.example.test/image.png"],
                    100,
                    {},
                    upscale_enabled=True,
                    upscale_model="pillow-lanczos",
                )

            archives = list(Path(temp_dir).glob("sample_*.zip"))
            self.assertEqual(len(archives), 1)
            self.assertEqual(handed_off, archives)

            with zipfile.ZipFile(archives[0]) as zf:
                names = zf.namelist()
                self.assertEqual(names, ["sample_001.png"])
                with zf.open(names[0]) as fh:
                    upscaled = Image.open(fh)
                    self.assertEqual(upscaled.size, (16, 12))

    def test_handoff_to_rclone_tries_gdrive_then_proton_until_success(self):
        with TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "download.zip"
            target.write_bytes(b"zip")
            calls = []

            def fake_run(cmd, capture_output, text, timeout):
                calls.append(cmd)

                class Result:
                    returncode = 1 if cmd[3].startswith("gdrive:") else 0
                    stderr = "quota"

                return Result()

            with (
                patch.dict(os.environ, {"PYTHON_ZIPPER_RCLONE_REMOTES": "gdrive:python-zipper,proton:python-zipper"}),
                patch.object(server.subprocess, "run", fake_run),
            ):
                self.assertTrue(server.handoff_to_rclone(str(target)))

            self.assertEqual(calls[0][:3], ["rclone", "move", str(target)])
            self.assertEqual(calls[1][:3], ["rclone", "move", str(target)])
            self.assertEqual(calls[0][3], "gdrive:python-zipper/")
            self.assertEqual(calls[1][3], "proton:python-zipper/")

    def test_handoff_to_rclone_keeps_local_file_when_all_remotes_fail(self):
        with TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "download.zip"
            target.write_bytes(b"zip")

            class Result:
                returncode = 1
                stderr = "offline"

            with (
                patch.dict(os.environ, {"PYTHON_ZIPPER_RCLONE_REMOTES": "gdrive:python-zipper"}),
                patch.object(server.subprocess, "run", lambda *args, **kwargs: Result()),
            ):
                self.assertFalse(server.handoff_to_rclone(str(target)))

            self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
