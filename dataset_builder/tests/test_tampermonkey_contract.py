import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "tampermonkey_script.js"
SRC_DIR = Path(__file__).resolve().parents[2] / "userscript" / "src"


class TampermonkeyContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sources = [SCRIPT.read_text(encoding="utf-8")]
        if SRC_DIR.exists():
            for p in sorted(SRC_DIR.rglob("*.ts")):
                sources.append(p.read_text(encoding="utf-8"))
        cls.source = "\n".join(sources)

    def test_userscript_uses_tampermonkey_storage_for_persistent_toggles(self):
        self.assertIn("getZipperSetting('highlight-enabled'", self.source)
        self.assertIn("setZipperSetting('highlight-enabled'", self.source)
        self.assertIn("getZipperSetting('upscale-enabled'", self.source)
        self.assertIn("setZipperSetting('upscale-enabled'", self.source)
        self.assertIn("getZipperSetting('server-download-enabled'", self.source)
        self.assertIn("setZipperSetting('server-download-enabled'", self.source)
        self.assertIn("getZipperSetting('rclone-enabled'", self.source)
        self.assertIn("setZipperSetting('rclone-enabled'", self.source)

    def test_userscript_has_primary_api_and_local_fallback_download_routing(self):
        self.assertIn('primary: "http://127.0.0.1:5171"', self.source)
        self.assertIn('local: "http://127.0.0.1:5171"', self.source)
        self.assertIn("sendWithFallback(routeKey", self.source)
        self.assertIn('await Api.sendWithFallback("download"', self.source)

    def test_userscript_normalizes_links_before_matching_and_sending(self):
        self.assertIn("function normalizeUrl", self.source)
        self.assertIn("function extractUrlsFromText", self.source)
        self.assertIn("normalizeUrl(url, window.location.href)", self.source)
        self.assertIn("extractUrlsFromText(rawText, window.location.href)", self.source)

    def test_userscript_dashboard_merges_api_and_local_jobs(self):
        self.assertIn("async function fetchJobsFromEndpoints", self.source)
        self.assertIn('["primary", "local", "localhost"]', self.source)
        self.assertIn("Object.assign(mergedJobs", self.source)

    def test_userscript_has_no_fxv_specific_fab_rule(self):
        self.assertNotIn("function isFxvHost", self.source)
        self.assertNotIn("isFxvHost()", self.source)
        self.assertNotIn("fxv", self.source.lower())

    def test_userscript_prefers_nomos_model_before_pillow_fallback(self):
        nomos_index = self.source.index('<option value="4xNomos8k_atd">')
        pillow_index = self.source.index('<option value="pillow-lanczos">')
        self.assertLess(nomos_index, pillow_index)


if __name__ == "__main__":
    unittest.main()
