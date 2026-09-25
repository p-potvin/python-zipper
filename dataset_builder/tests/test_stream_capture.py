"""What a finished recording is called, and whether it has any sound.

Both rules were broken in ways no test could see, because the tests stopped at
the pure helpers and neither bug lived there:

  * naming was correct but was handed an empty title, every single time;
  * the format the quality dropdown sends is *video only* on every HLS master
    these sites publish, so the recording came out silent.

    python -m unittest dataset_builder.tests.test_stream_capture
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from ds_streams import (
    _finalize_stream_name, _format_selector, _sanitize_stream_url,
    strip_delivery_directives, stream_label, site_label, url_label,
)


class FinalizeStreamNameTests(unittest.TestCase):
    """The renamer takes the title as an argument; it used to look it up."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def _recording(self, name="pzstream_abc123_master [x].mp4"):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(b"0")
        return path

    def test_title_given_becomes_the_filename(self):
        out = _finalize_stream_name(self._recording(), "abc123", "[cam.example] Ophelia's room")
        self.assertEqual(os.path.basename(out), "Ophelia Stream #01.mp4")
        self.assertTrue(os.path.exists(out))

    def test_second_recording_of_the_same_subject_is_numbered(self):
        first = _finalize_stream_name(self._recording(), "abc123", "Ophelia is live now")
        second = _finalize_stream_name(
            self._recording("pzstream_def456_master [y].mp4"), "def456", "Ophelia is live now",
        )
        self.assertEqual(os.path.basename(first), "Ophelia Stream #01.mp4")
        self.assertEqual(os.path.basename(second), "Ophelia Stream #02.mp4")

    def test_no_title_still_falls_back_rather_than_failing(self):
        # The old behaviour, which is now the fallback instead of the only path.
        out = _finalize_stream_name(self._recording(), "abc123", "")
        self.assertEqual(os.path.basename(out), "stream_abc123.mp4")

    def test_title_is_optional(self):
        # download_stream passes title=None when a job carried none.
        out = _finalize_stream_name(self._recording(), "abc123", None)
        self.assertEqual(os.path.basename(out), "stream_abc123.mp4")


class FormatSelectorTests(unittest.TestCase):
    """A chosen video format must carry an audio rendition along with it."""

    def test_a_plain_format_id_gains_an_audio_rendition(self):
        self.assertEqual(_format_selector("4670"), "4670+ba/4670")

    def test_it_can_still_fall_back_to_the_bare_format(self):
        # Muxed chunklists have no rendition to merge; without the `/<fid>`
        # tail yt-dlp errors instead of recording what is actually there.
        self.assertTrue(_format_selector("hls-1080").endswith("/hls-1080"))

    def test_no_format_id_asks_for_video_plus_audio(self):
        self.assertEqual(_format_selector(None), "bv*+ba/b")
        self.assertEqual(_format_selector(""), "bv*+ba/b")

    def test_an_expression_the_caller_built_is_left_alone(self):
        for expr in ("bv*+ba/b", "best[height<=720]", "137+140"):
            self.assertEqual(_format_selector(expr), expr)


class DeliveryDirectiveTests(unittest.TestCase):
    """A request for one part of a live playlist is not the playlist.

    Reported from chaturbate: the capture ran, retried fifteen times against a
    sequence number frozen at capture time, and was answered 403 about five
    minutes later — then the ffmpeg fallback was handed the same URL and failed
    identically, which made one URL problem look like two client problems.
    """

    CHATURBATE = (
        "https://edge26-ash.live.mmcdn.com/v1/edge/streams/origin.x.01M2/"
        "chunklist_3_video_827_llhls.m3u8?sn=10176&_HLS_part=0"
    )

    def test_the_blocking_hints_are_dropped(self):
        out = strip_delivery_directives(self.CHATURBATE)
        self.assertNotIn("_HLS_part", out)
        self.assertNotIn("sn=", out)
        self.assertTrue(out.endswith("chunklist_3_video_827_llhls.m3u8"), out)

    def test_auth_survives(self):
        url = "https://cdn.example.com/live/c.m3u8?token=abc&expires=9&_HLS_msn=44"
        out = strip_delivery_directives(url)
        self.assertIn("token=abc", out)
        self.assertIn("expires=9", out)
        self.assertNotIn("_HLS_msn", out)

    def test_nothing_is_stripped_without_a_directive(self):
        # A bare `sn` elsewhere may well be part of the identity.
        url = "https://cdn.example.com/live/master.m3u8?sn=5&token=z"
        self.assertEqual(strip_delivery_directives(url), url)

    def test_urls_without_a_query_are_untouched(self):
        url = "https://cdn.example.com/live/master.m3u8"
        self.assertEqual(strip_delivery_directives(url), url)

    def test_the_sanitiser_applies_it(self):
        # download_stream and probe_stream both go through this, so the ffmpeg
        # fallback cannot be handed a different URL than yt-dlp got.
        self.assertNotIn("_HLS_part", _sanitize_stream_url(self.CHATURBATE))

    def test_the_sanitiser_still_refuses_what_it_refused(self):
        self.assertIsNone(_sanitize_stream_url("-oh no"))
        self.assertIsNone(_sanitize_stream_url("ftp://cdn.example.com/x.m3u8"))
        self.assertIsNone(_sanitize_stream_url("https://user:pw@cdn.example.com/x.m3u8"))
        self.assertIsNone(_sanitize_stream_url(""))


class StreamLabelTests(unittest.TestCase):
    """Every step of the naming chain, because every one of them used to be
    skipped: naming read an always-empty job store, so a recording was named
    from its URL and the answer was usually "chunklist"."""

    def test_the_performer_wins(self):
        self.assertEqual(
            stream_label("[chaturbate.com] blissdilley",
                         "https://chaturbate.com/blissdilley/", "chunklist_3_video"),
            "blissdilley",
        )

    def test_the_whole_tab_title_when_there_is_nothing_to_cut_at(self):
        self.assertEqual(
            stream_label("[site.com] Live Cam Shows", "https://site.com/x", "master"),
            "Live Cam Shows",
        )

    def test_the_file_name_when_it_carries_a_real_title(self):
        self.assertEqual(stream_label("", "", "Real Stream Title"), "Real Stream Title")

    def test_the_site_when_the_title_gives_nothing(self):
        self.assertEqual(
            stream_label("", "https://www.camsoda.com/sophie", "master"), "camsoda.com",
        )

    def test_generic_file_names_are_not_labels(self):
        for junk in ("master", "chunklist", "index", "playlist", "stream"):
            self.assertEqual(stream_label("", "", junk), "", junk)

    def test_nothing_anywhere_is_reported_as_nothing(self):
        # The caller falls back to the job id; this must not invent a label.
        self.assertEqual(stream_label("", "", ""), "")

    def test_the_host_comes_from_the_title_when_there_is_no_page_url(self):
        self.assertEqual(site_label("", "[chaturbate.com] anything"), "chaturbate.com")

    def test_www_goes_but_the_tld_stays(self):
        self.assertEqual(site_label("https://www.example.com/x"), "example.com")


class SiteNamedRecordingTests(unittest.TestCase):
    """A recording named after its site is still numbered."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def _recording(self, name):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(b"0")
        return path

    def test_a_site_named_recording_is_numbered(self):
        out = _finalize_stream_name(
            self._recording("pzstream_abc123_master [x].ts"), "abc123",
            "", "https://camsoda.com/sophie",
        )
        self.assertEqual(os.path.basename(out), "camsoda.com Stream #01.ts")

    def test_the_second_one_does_not_read_as_a_duplicate_file(self):
        _finalize_stream_name(
            self._recording("pzstream_a_master [x].ts"), "a", "", "https://camsoda.com/x")
        out = _finalize_stream_name(
            self._recording("pzstream_b_master [x].ts"), "b", "", "https://camsoda.com/x")
        self.assertEqual(os.path.basename(out), "camsoda.com Stream #02.ts")

    def test_a_resumed_recording_is_not_named_after_its_own_part_file(self):
        # _concat_parts produces "..._joined.ts"; that is this module talking to
        # itself, not a title.
        out = _finalize_stream_name(
            self._recording("pzstream_abc123_joined.ts"), "abc123",
            "[chaturbate.com] blissdilley", "https://chaturbate.com/blissdilley/",
        )
        self.assertEqual(os.path.basename(out), "blissdilley Stream #01.ts")


class PlayerLabelTests(unittest.TestCase):
    """The DOM title extractor reads the label nearest the media element, and
    on many players that label is the word "player". It outranks every other
    source, which is how a recording was named "Video Player Stream #04" on a
    page whose tab title, hostname and stream URL all named the broadcaster."""

    URL = ("https://edge9-ash.live.mmcdn.com/v1/edge/streams/"
           "origin.pinkadele.01M31QZGYQA95T85Q1H97RSEAX/chunklist_3_video_169.m3u8?session=x")

    def test_the_broadcaster_is_read_out_of_the_stream_path(self):
        self.assertEqual(url_label(self.URL), "pinkadele")

    def test_a_player_label_loses_to_the_url(self):
        self.assertEqual(
            stream_label("[chaturbate.com] Video Player",
                         "https://chaturbate.com/pinkadele/", "chunklist", self.URL),
            "pinkadele",
        )

    def test_a_real_title_still_wins(self):
        self.assertEqual(
            stream_label("[chaturbate.com] someone else",
                         "https://chaturbate.com/x/", "chunklist", self.URL),
            "someone else",
        )

    def test_without_a_url_a_player_label_falls_through_to_the_site(self):
        self.assertEqual(
            stream_label("[chaturbate.com] Video Player", "https://chaturbate.com/x/", "master"),
            "chaturbate.com",
        )

    def test_hosts_that_write_no_name_yield_nothing(self):
        self.assertEqual(url_label("https://cdn.example.com/live/master.m3u8"), "")
        self.assertEqual(url_label(""), "")


if __name__ == "__main__":
    unittest.main()
