"""Resuming a recording on a refreshed URL.

Exercised with a fake yt-dlp so the loop's decisions are visible: how many
times it restarts, which URL each attempt used, and what it does when the
browser has nothing newer to offer. These only fire on failure, which is
exactly the path nobody exercises by hand.

    python -m unittest dataset_builder.tests.test_stream_resume
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import ds_streams


class FakeProc:
    """Stands in for yt-dlp: emits its lines, then exits with `code`."""

    def __init__(self, lines, code):
        self.stdout = iter(lines)
        self.returncode = code

    def wait(self):
        return self.returncode


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.attempts = []
        # A restart normally waits out MIN_ATTEMPT_SECONDS; the tests assert on
        # the decisions, not on the wall clock.
        patcher = patch.object(ds_streams.time, "sleep", lambda *_: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        d = patch.object(ds_streams, "STREAMS_DIR", self.dir)
        d.start()
        self.addCleanup(d.stop)

    def _run(self, fresh_urls, produce=False, code=1):
        """Run download_stream with a scripted sequence of refreshed URLs."""
        seq = list(fresh_urls)

        def fake_popen(cmd, **kwargs):
            url = cmd[-1]
            self.attempts.append(url)
            if produce:
                out = [a for a in cmd if a == "-o"]
                idx = cmd.index("-o") + 1
                target = cmd[idx]
                if "%(" not in target:
                    with open(target, "wb") as fh:
                        fh.write(b"\x47" + b"\0" * 1024)
            return FakeProc(["PZPROG:1024/0/0/0/0", "ERROR: 403"], code)

        def refresh():
            return seq.pop(0) if seq else ""

        reports = []

        class R:
            def update(self, jid, **f): reports.append(("update", f))
            def complete(self, jid, **f): reports.append(("complete", f))
            def fail(self, jid, err): reports.append(("fail", str(err)))

        with patch.object(ds_streams.subprocess, "Popen", fake_popen), \
             patch.object(ds_streams, "record_with_ffmpeg", lambda *a, **k: (False, "no")):
            ds_streams.download_stream(
                "job1", "https://cdn.example.com/live/a.m3u8?t=1",
                report=R(), refresh_url=refresh,
            )
        return reports

    def test_it_restarts_on_a_newer_url(self):
        self._run(["https://cdn.example.com/live/a.m3u8?t=2", ""])
        self.assertEqual(len(self.attempts), 2, self.attempts)
        self.assertTrue(self.attempts[0].endswith("t=1"))
        self.assertTrue(self.attempts[1].endswith("t=2"))

    def test_it_stops_when_the_browser_has_nothing_newer(self):
        self._run([])
        self.assertEqual(len(self.attempts), 1, self.attempts)

    def test_the_same_url_again_is_not_a_resume(self):
        # The tab is open but its URL has not rotated; retrying it would spin.
        self._run(["https://cdn.example.com/live/a.m3u8?t=1"])
        self.assertEqual(len(self.attempts), 1, self.attempts)

    def test_resumes_are_bounded(self):
        many = [f"https://cdn.example.com/live/a.m3u8?t={i}" for i in range(2, 60)]
        self._run(many)
        self.assertEqual(len(self.attempts), ds_streams.MAX_RESUMES + 1, len(self.attempts))

    def test_a_user_stop_ends_it_immediately(self):
        ds_streams.STOPPED.add("job1")
        self.addCleanup(lambda: ds_streams.STOPPED.discard("job1"))
        self._run(["https://cdn.example.com/live/a.m3u8?t=2"])
        self.assertEqual(len(self.attempts), 1, self.attempts)

    def test_a_refresh_that_throws_is_not_fatal(self):
        def boom():
            raise RuntimeError("API down")

        with patch.object(ds_streams.subprocess, "Popen",
                          lambda cmd, **k: (self.attempts.append(cmd[-1]),
                                            FakeProc(["ERROR"], 1))[1]), \
             patch.object(ds_streams, "record_with_ffmpeg", lambda *a, **k: (False, "no")):
            ds_streams.download_stream("job1", "https://cdn.example.com/a.m3u8",
                                       report=ds_streams._Reporter(
                                           update=lambda *a, **k: None,
                                           complete=lambda *a, **k: None,
                                           fail=lambda *a, **k: None),
                                       refresh_url=boom)
        self.assertEqual(len(self.attempts), 1)

    def test_no_refresher_behaves_exactly_as_before(self):
        with patch.object(ds_streams.subprocess, "Popen",
                          lambda cmd, **k: (self.attempts.append(cmd[-1]),
                                            FakeProc(["ERROR"], 1))[1]), \
             patch.object(ds_streams, "record_with_ffmpeg", lambda *a, **k: (False, "no")):
            ds_streams.download_stream("job1", "https://cdn.example.com/a.m3u8",
                                       report=ds_streams._Reporter(
                                           update=lambda *a, **k: None,
                                           complete=lambda *a, **k: None,
                                           fail=lambda *a, **k: None))
        self.assertEqual(len(self.attempts), 1)


class ConcatTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        d = patch.object(ds_streams, "STREAMS_DIR", self.dir)
        d.start()
        self.addCleanup(d.stop)

    def _mk(self, name, size=100):
        p = os.path.join(self.dir, name)
        with open(p, "wb") as fh:
            fh.write(b"x" * size)
        return p

    def test_a_single_piece_is_returned_untouched(self):
        one = self._mk("pzstream_j_a.ts")
        self.assertEqual(ds_streams._concat_parts([one], "j"), one)

    def test_pieces_are_listed_oldest_first(self):
        import time as _t
        a = self._mk("pzstream_j_first.ts")
        _t.sleep(0.02)
        b = self._mk("pzstream_j_resume01.ts")
        found = ds_streams._find_outputs("pzstream_j_")
        self.assertEqual([os.path.basename(x) for x in found],
                         [os.path.basename(a), os.path.basename(b)])

    def test_a_failed_join_keeps_the_longest_piece(self):
        a = self._mk("pzstream_j_a.ts", 10)
        b = self._mk("pzstream_j_b.ts", 900)

        class Boom:
            returncode = 1
            stderr = "nope"

        with patch.object(ds_streams.subprocess, "run", lambda *a, **k: Boom()):
            self.assertEqual(ds_streams._concat_parts([a, b], "j"), b)

    def test_partials_are_not_counted_as_output(self):
        self._mk("pzstream_j_a.ts.part")
        self._mk("pzstream_j_a.ytdl")
        self.assertEqual(ds_streams._find_outputs("pzstream_j_"), [])


class PairedPlaylistTests(unittest.TestCase):
    """A stream published as two playlists has to be recorded as two inputs.

    Chaturbate serves `chunklist_3_video_<id>_llhls.m3u8` and
    `chunklist_5_audio_<id>_llhls.m3u8` with no master joining them, so yt-dlp
    is handed one media playlist, sees one format, and records silence however
    the format selector is written.
    """

    VIDEO = "https://edge9.example.com/v1/edge/streams/origin.x.01M/chunklist_3_video_169361845355.m3u8?session=a"
    AUDIO = "https://edge20.example.com/v1/edge/streams/origin.x.01M/chunklist_5_audio_169361845355.m3u8?session=a"

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        d = patch.object(ds_streams, "STREAMS_DIR", self.dir)
        d.start()
        self.addCleanup(d.stop)
        self.cmds = []

    def _capture(self, **kw):
        def fake_run(cmd, **kwargs):
            self.cmds.append(cmd)
            out = cmd[-1]
            with open(out, "wb") as fh:
                fh.write(bytes(513))
            return FakeProc(["total_size=513"], 0)

        class Silent:
            def update(self, *a, **k): pass
            def complete(self, *a, **k): pass
            def fail(self, *a, **k): pass

        with patch.object(ds_streams.subprocess, "Popen", fake_run):
            ds_streams.download_stream("job9", self.VIDEO, report=Silent(), **kw)
        return self.cmds[0]

    def test_both_playlists_reach_ffmpeg(self):
        cmd = self._capture(audio_url=self.AUDIO)
        inputs = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-i"]
        self.assertEqual(len(inputs), 2, cmd)
        self.assertIn("_video_", inputs[0])
        self.assertIn("_audio_", inputs[1])

    def test_the_streams_are_mapped_explicitly(self):
        cmd = self._capture(audio_url=self.AUDIO)
        self.assertIn("0:v:0?", cmd)
        self.assertIn("1:a:0?", cmd)

    def test_nothing_is_re_encoded(self):
        cmd = self._capture(audio_url=self.AUDIO)
        self.assertIn("-c", cmd)
        self.assertEqual(cmd[cmd.index("-c") + 1], "copy")

    def test_headers_are_sent_for_both_inputs(self):
        # ffmpeg applies -headers to the -i that follows, so a single copy
        # would authenticate the video and leave the audio to 403.
        self.cmds = []
        cmd = self._capture(audio_url=self.AUDIO, headers={"Cookie": "a=b"})
        self.assertEqual(cmd.count("-headers"), 2, cmd)

    def test_without_an_audio_playlist_it_is_still_yt_dlp(self):
        cmd = self._capture()
        self.assertNotIn("-i", cmd)

    def test_a_resume_refreshes_both_halves(self):
        seq = [{"stream_url": self.VIDEO.replace("session=a", "session=b"),
                "audio_url": self.AUDIO.replace("session=a", "session=b")}]

        def fake_run(cmd, **kwargs):
            self.cmds.append(cmd)
            return FakeProc([], 1)          # produced nothing

        class Silent:
            def update(self, *a, **k): pass
            def complete(self, *a, **k): pass
            def fail(self, *a, **k): pass

        with patch.object(ds_streams.subprocess, "Popen", fake_run),              patch.object(ds_streams.time, "sleep", lambda *_: None):
            ds_streams.download_stream(
                "job9", self.VIDEO, report=Silent(), audio_url=self.AUDIO,
                refresh_url=lambda: seq.pop(0) if seq else {},
            )
        second = self.cmds[1]
        inputs = [second[i + 1] for i, a in enumerate(second) if a == "-i"]
        self.assertTrue(all("session=b" in u for u in inputs), inputs)


if __name__ == "__main__":
    unittest.main()
