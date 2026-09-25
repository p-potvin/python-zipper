"""Livestream file naming.

The rule is small but every part of it earns its place, and all of it is easy to
break by tidying: cutting at the wrong word, keeping the possessive, or letting
a title that is *only* boilerplate produce a file called "Stream #01" with no
subject in it.

    python -m unittest dataset_builder.tests.test_stream_naming
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from ds_streams import stream_basename, next_stream_index, stream_filename


class TestBasename(unittest.TestCase):
    def test_cuts_at_the_room_word_and_drops_the_possessive(self):
        self.assertEqual(stream_basename("Ada Luna's Room - Chaturbate"), "Ada Luna")

    def test_cuts_at_live(self):
        self.assertEqual(stream_basename("SomeName Live now | 1,204 viewers"), "SomeName")

    def test_cuts_at_cam(self):
        self.assertEqual(stream_basename("YasmineVixen's Cam - LiveMediaHost"), "YasmineVixen")

    def test_takes_the_first_cut_word_not_the_last(self):
        # "Live" comes first, so "Cam Show" is tail, not part of the name.
        self.assertEqual(stream_basename("ada_luna01 - Live Cam Show"), "ada_luna01")

    def test_plurals_count(self):
        self.assertEqual(stream_basename("Bob's Rooms"), "Bob")

    def test_a_title_with_no_cut_word_is_kept_whole(self):
        self.assertEqual(
            stream_basename("A Perfectly Normal Video Title"),
            "A Perfectly Normal Video Title",
        )

    def test_a_bare_handle_survives(self):
        self.assertEqual(stream_basename("ada_luna01"), "ada_luna01")

    def test_nothing_before_the_cut_word_yields_nothing(self):
        # The caller must fall back rather than name a file after no one.
        self.assertEqual(stream_basename("Cams - nothing before the word"), "")
        self.assertEqual(stream_basename("Live"), "")

    def test_empty_and_none_are_safe(self):
        self.assertEqual(stream_basename(""), "")
        self.assertEqual(stream_basename(None), "")

    def test_filesystem_hostile_characters_go(self):
        self.assertNotIn("/", stream_basename("a/b's Room"))
        self.assertNotIn(":", stream_basename("a:b's Room"))

    def test_a_curly_apostrophe_is_handled_too(self):
        # Real titles use U+2019 far more often than a straight quote.
        self.assertEqual(stream_basename("Ada Luna\u2019s Room"), "Ada Luna")


class TestNumbering(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _touch(self, name):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
            fh.write("x")

    def test_starts_at_one_in_an_empty_directory(self):
        self.assertEqual(next_stream_index(self.dir, "Ada Luna"), 1)

    def test_continues_past_what_is_on_disk(self):
        for n in (1, 2, 7):
            self._touch(f"Ada Luna Stream #{n:02d}.ts")
        self.assertEqual(next_stream_index(self.dir, "Ada Luna"), 8)

    def test_counts_only_this_subject(self):
        self._touch("Ada Luna Stream #04.ts")
        self._touch("Someone Else Stream #09.ts")
        self.assertEqual(next_stream_index(self.dir, "Someone Else"), 10)

    def test_a_missing_directory_does_not_raise(self):
        self.assertEqual(next_stream_index(os.path.join("no", "such", "dir"), "Ada"), 1)

    def test_zero_padded_to_two_digits(self):
        self.assertEqual(stream_filename("Ada Luna's Room", self.dir), "Ada Luna Stream #01")

    def test_padding_widens_rather_than_truncating(self):
        for n in range(1, 100):
            self._touch(f"Ada Stream #{n:02d}.ts")
        # Past 99 the number keeps counting; it must not wrap back to 00.
        self.assertEqual(stream_filename("Ada's Room", self.dir), "Ada Stream #100")

    def test_no_usable_title_gives_no_name(self):
        self.assertEqual(stream_filename("Live", self.dir), "")
        self.assertEqual(stream_filename("", self.dir), "")


if __name__ == "__main__":
    unittest.main()
