"""The richer name, the sidecar, and renaming both together."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ds_records  # noqa: E402
from ds_streams import (  # noqa: E402
    _finalize_stream_name, classic_hls, url_label, rich_suffix,
)

CAMSODA = ("https://streaming-edge-front.livemediahost.com/edge8-ild/cam_obs/"
           "madelinefox-flu_v1/index.ll.m3u8?multitrack=true&filter=tracks:v4v3v2v1a1a2&token=abc")


class FlussonicTests(unittest.TestCase):
    def test_low_latency_playlist_becomes_its_classic_twin(self):
        out = classic_hls(CAMSODA)
        self.assertIn("/madelinefox-flu_v1/index.m3u8?", out)
        self.assertIn("token=abc", out)
        self.assertIn("filter=tracks", out)

    def test_anything_else_is_untouched(self):
        url = "https://edge.example/v1/edge/streams/origin.ada.01ABCDEFGH/llhls.m3u8?token=x"
        self.assertEqual(classic_hls(url), url)

    def test_the_model_name_comes_out_of_the_path(self):
        self.assertEqual(url_label(CAMSODA), "madelinefox")


class RichNameTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def _recording(self, name="pzstream_abc123_capture.ts"):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(b"0")
        return path

    def test_everything_known_goes_after_the_number(self):
        info = {"started_local": "2026-09-23 21h45", "height": 1080, "duration": 4980,
                "site": "camsoda.com"}
        out = _finalize_stream_name(self._recording(), "abc123", "", "https://www.camsoda.com/madelinefox",
                                    CAMSODA, info)
        self.assertEqual(
            os.path.basename(out),
            "madelinefox Stream #01 - camsoda.com - 2026-09-23 21h45 - 1080p - 1h23m.ts",
        )
        self.assertEqual(info["label"], "madelinefox")

    def test_numbering_still_counts_rich_names(self):
        info = {"started_local": "2026-09-23 21h45"}
        _finalize_stream_name(self._recording(), "a", "Ada's room", "", "", dict(info))
        out = _finalize_stream_name(self._recording("pzstream_b_capture.ts"), "b",
                                    "Ada's room", "", "", dict(info))
        self.assertTrue(os.path.basename(out).startswith("Ada Stream #02 - "))

    def test_a_display_name_keeps_the_username_beside_it(self):
        suffix = rich_suffix("Ada Luna", {"username": "adaluna_x"})
        self.assertEqual(suffix, "adaluna_x")

    def test_a_performer_outranks_a_player_label(self):
        out = _finalize_stream_name(self._recording(), "abc", "Video Player", "", "",
                                    {"performer": "Ada Luna"})
        self.assertTrue(os.path.basename(out).startswith("Ada Luna Stream #01"))

    def test_without_info_the_old_name_is_unchanged(self):
        out = _finalize_stream_name(self._recording(), "abc", "Ada's room")
        self.assertEqual(os.path.basename(out), "Ada Stream #01.ts")


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "Ada Stream #01.ts")
        with open(self.path, "wb") as fh:
            fh.write(b"0" * 10)

    def _record(self):
        return ds_records.build_record(self.path, "z-1", {
            "stream_url": CAMSODA, "page_url": "https://www.camsoda.com/ada",
            "headers_used": ["Referer", "Authorization"], "recorder": "ffmpeg",
            "resumes": 2, "end_reason": "stopped",
        }, {"height": 720, "duration": 12.5})

    def test_written_under_the_canonical_name(self):
        target = ds_records.write_sidecar(self.path, self._record())
        self.assertEqual(target, self.path + ".json")
        with open(target, encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["schema"], 2)
        self.assertEqual(data["height"], 720)
        self.assertEqual(data["capture"]["resumes"], 2)
        self.assertEqual(data["provenance"]["job_id"], "z-1")

    def test_the_token_never_reaches_the_record(self):
        text = json.dumps(self._record())
        self.assertNotIn("token=abc", text)
        self.assertIn("index.ll.m3u8", text)

    def test_header_names_only(self):
        rec = self._record()
        self.assertEqual(rec["capture"]["headers_used"], ["Authorization", "Referer"])

    def test_rename_moves_the_sidecar_and_logs_it(self):
        ds_records.write_sidecar(self.path, self._record())
        out = ds_records.rename_recording(self.path, "Ada: best show?", by="user")
        self.assertEqual(os.path.basename(out), "Ada_ best show_.ts")
        self.assertFalse(os.path.exists(self.path + ".json"))
        with open(out + ".json", encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["history"][-1]["from"], "Ada Stream #01.ts")
        self.assertEqual(data["master"]["basename"], "Ada_ best show_.ts")

    def test_an_empty_name_changes_nothing(self):
        self.assertEqual(ds_records.rename_recording(self.path, "  "), self.path)

    def test_a_typed_extension_is_not_doubled(self):
        out = ds_records.rename_recording(self.path, "Ada final.ts")
        self.assertEqual(os.path.basename(out), "Ada final.ts")


if __name__ == "__main__":
    unittest.main()
