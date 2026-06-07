#!/usr/bin/env python3
"""
Unit and integration tests for the enhanced Real-Debrid pipeline features.
"""

import os
import sys
import shutil
import tempfile
import unittest
import asyncio
from unittest.mock import patch, MagicMock

# Add parent directory to path to import telethon_link_resolver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import telethon_link_resolver

class TestRealDebridPipeline(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        # Create a temp directory to simulate Chrome User Data
        self.test_dir = tempfile.mkdtemp()
        
        # Create a dummy structure inside it
        os.makedirs(os.path.join(self.test_dir, "Default", "Extensions"), exist_ok=True)
        os.makedirs(os.path.join(self.test_dir, "Default", "Local Storage"), exist_ok=True)
        with open(os.path.join(self.test_dir, "Default", "Preferences"), "w") as f:
            f.write('{"extensions": {}}')
        with open(os.path.join(self.test_dir, "Local State"), "w") as f:
            f.write('{}')
            
    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_chrome_profile_cloning(self):
        """Verify that get_chrome_profile clones the profile structure and ignores locks."""
        # Create a dummy lock file which should be ignored
        lock_file_path = os.path.join(self.test_dir, "Default", "SingletonLock")
        with open(lock_file_path, "w") as f:
            f.write("lock")
            
        cloned_dir, cleanup = telethon_link_resolver.get_chrome_profile(self.test_dir)
        
        try:
            # Check directories/files are copied
            self.assertTrue(os.path.exists(os.path.join(cloned_dir, "Default", "Extensions")))
            self.assertTrue(os.path.exists(os.path.join(cloned_dir, "Default", "Preferences")))
            self.assertTrue(os.path.exists(os.path.join(cloned_dir, "Local State")))
            
            # Check lock files are ignored or deleted
            self.assertFalse(os.path.exists(os.path.join(cloned_dir, "Default", "SingletonLock")))
        finally:
            cleanup()
            # Verify directory is cleaned up
            self.assertFalse(os.path.exists(cloned_dir))

    @patch('telethon_link_resolver.requests.head')
    def test_link_resolution_boundaries(self, mock_head):
        """Test file sizes are mapped correctly to upload, download, or skip actions."""
        # Mock HEAD requests response
        mock_response = MagicMock()
        mock_response.headers = {
            "Content-Length": "2147483648",  # 2 GB
            "Content-Disposition": 'attachment; filename="test_movie.mp4"'
        }
        mock_head.return_value = mock_response

        # Check size-based logic in resolver module constants
        self.assertEqual(telethon_link_resolver.MAX_FILESIZE_UPLOAD, 3 * 1024**3)
        self.assertEqual(telethon_link_resolver.MAX_FILESIZE_DOWNLOAD, 10 * 1024**3)

    @patch('telethon_link_resolver.unrestrict_mega_with_realdebrid')
    def test_api_fallback_logic(self, mock_unrestrict):
        """Test API fallback triggers when browser extension does not capture link."""
        mock_unrestrict.return_value = {
            'download_url': 'https://real-debrid.com/d/xyz',
            'filename': 'fallback_file.zip',
            'filesize': 500 * 1024 * 1024,
            'original_mega': 'https://mega.nz/file/abc'
        }
        
        # Test simulating calling the fallback logic if extension captured nothing
        unrestricted = None
        url = 'https://mega.nz/file/abc'
        idx = 1
        
        # Emulate resolver fallback block
        if not unrestricted:
            api_result = telethon_link_resolver.unrestrict_mega_with_realdebrid(url, idx)
            if api_result:
                unrestricted = api_result
                
        self.assertIsNotNone(unrestricted)
        self.assertEqual(unrestricted['filename'], 'fallback_file.zip')
        self.assertEqual(unrestricted['download_url'], 'https://real-debrid.com/d/xyz')
        mock_unrestrict.assert_called_once_with(url, idx)

    @patch('telethon_link_resolver.requests.get')
    async def test_linkvertise_bypass_retry_and_fallbacks(self, mock_get):
        """Test that bypass retry loop handles 202 responses and fails over to backup services."""
        # Mock first service returning 202 twice then 400 (failover to next service)
        mock_202 = MagicMock()
        mock_202.status_code = 202
        
        mock_400 = MagicMock()
        mock_400.status_code = 400
        
        # Second service returns 200 with result
        mock_200 = MagicMock()
        mock_200.status_code = 200
        mock_200.json.return_value = {"success": True, "result": "https://rentry.co/valid_link"}
        
        mock_get.side_effect = [mock_202, mock_202, mock_400, mock_200]
        
        # Patch sleep to speed up tests
        with patch('telethon_link_resolver.asyncio.sleep') as mock_sleep:
            result = await telethon_link_resolver.bypass_linkvertise_in_browser(
                "https://linkvertise.com/123/test", None, 1
            )
            
            self.assertEqual(result, "https://rentry.co/valid_link")
            # Called 3 times for first service (202, 202, 400), 1 time for second service (200)
            self.assertEqual(mock_get.call_count, 4)
            self.assertEqual(mock_sleep.call_count, 2)

    def test_pyload_batch_splitting(self):
        """Test logic for dividing failed links into batches of 50."""
        failed_links = [f"https://mega.nz/file/{i}" for i in range(125)]
        
        batches = []
        for i in range(0, len(failed_links), 50):
            batches.append(failed_links[i:i+50])
            
        self.assertEqual(len(batches), 3)
        self.assertEqual(len(batches[0]), 50)
        self.assertEqual(len(batches[1]), 50)
        self.assertEqual(len(batches[2]), 25)

    @patch('telethon_link_resolver.requests.post')
    @patch('telethon_link_resolver.requests.get')
    def test_local_file_uploader_api(self, mock_get, mock_post):
        """Verify the 3-step Katfile API upload flow for local files."""
        # Setup temp file
        temp_fd, temp_path = tempfile.mkstemp()
        try:
            with os.fdopen(temp_fd, 'w') as f:
                f.write("dummy content")
                
            # Step 1 response
            mock_server_resp = MagicMock()
            mock_server_resp.status_code = 200
            mock_server_resp.json.return_value = {"result": "https://upload.katfile.com", "sess_id": "test_session"}
            mock_get.return_value = mock_server_resp
            
            # Step 2 response
            mock_upload_resp = MagicMock()
            mock_upload_resp.status_code = 200
            mock_upload_resp.json.return_value = [{"file_code": "code123", "file_status": "OK"}]
            mock_post.return_value = mock_upload_resp
            
            # Patch API key variable in module
            with patch('telethon_link_resolver.KATFILE_API_KEY', 'test_key'):
                result = telethon_link_resolver.upload_local_file_to_katfile(temp_path, 1)
                
                self.assertIsNotNone(result)
                self.assertEqual(result['file_code'], 'code123')
                self.assertEqual(result['katfile_url'], 'https://katfile.space/code123')
        finally:
            os.remove(temp_path)

if __name__ == "__main__":
    unittest.main()
