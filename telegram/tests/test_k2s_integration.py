import unittest
import os
import tempfile
from unittest.mock import patch, MagicMock
import sys

# Ensure telegram directory is in the path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import k2s_uploader

class TestK2sUploader(unittest.TestCase):
    def setUp(self):
        # Create a temporary file to upload
        self.test_file = tempfile.NamedTemporaryFile(delete=False)
        self.test_file.write(b"Test content for FileBoom and Keep2Share uploader")
        self.test_file.close()

    def tearDown(self):
        if os.path.exists(self.test_file.name):
            os.remove(self.test_file.name)

    def test_compute_md5(self):
        """Verify md5 hash calculation matches expected checksum."""
        md5_hash = k2s_uploader.compute_md5(self.test_file.name)
        self.assertIsNotNone(md5_hash)
        self.assertEqual(len(md5_hash), 32)

    @patch('requests.post')
    def test_upload_instant_hash_match(self, mock_post):
        """Verify successful instant hash match bypasses full upload."""
        # Mock responses
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "status": "success",
            "code": 200,
            "id": "instant123",
            "link": "https://fboom.me/file/instant123"
        }
        mock_post.return_value = mock_response

        res = k2s_uploader.upload_file_dual(self.test_file.name)
        
        self.assertIsNotNone(res)
        self.assertEqual(res["service"], "FBOOM")
        self.assertEqual(res["link"], "https://fboom.me/file/instant123")
        self.assertTrue(res["instant"])
        
        # Verify it only called createFileByHash and skipped getUploadFormData
        called_endpoints = [args[0] for args, kwargs in mock_post.call_args_list]
        self.assertTrue(any("createFileByHash" in url for url in called_endpoints))
        self.assertFalse(any("getUploadFormData" in url for url in called_endpoints))

    @patch('requests.post')
    def test_upload_multipart_fallback(self, mock_post):
        """Verify full multipart upload occurs when hash match is not found."""
        # 1. createFileByHash returns error code 20 (File not found)
        # 2. getUploadFormData returns upload endpoint details
        # 3. Raw file upload returns success
        mock_hash_resp = MagicMock()
        mock_hash_resp.status_code = 406
        mock_hash_resp.json.return_value = {
            "status": "error",
            "code": 406,
            "errorCode": 20,
            "message": "File not found"
        }

        mock_form_resp = MagicMock()
        mock_form_resp.status_code = 200
        mock_form_resp.json.return_value = {
            "status": "success",
            "form_action": "https://upload.fboom.me/up123",
            "file_field": "file",
            "form_data": {"signature": "sig123", "params": "param123"}
        }

        mock_up_resp = MagicMock()
        mock_up_resp.status_code = 200
        mock_up_resp.json.return_value = {
            "status": "success",
            "user_file_id": "file999",
            "link": "https://fboom.me/file/file999"
        }

        # Side effect to return responses in order
        mock_post.side_effect = [mock_hash_resp, mock_form_resp, mock_up_resp]

        res = k2s_uploader.upload_file_dual(self.test_file.name)
        
        self.assertIsNotNone(res)
        self.assertEqual(res["service"], "FBOOM")
        self.assertEqual(res["link"], "https://fboom.me/file/file999")
        self.assertFalse(res["instant"])

    @patch('requests.post')
    def test_upload_service_failover(self, mock_post):
        """Verify automatic failover to Keep2Share when FileBoom fails completely."""
        # FileBoom calls (createFileByHash, getUploadFormData) return errors
        fb_hash_resp = MagicMock()
        fb_hash_resp.status_code = 500
        fb_hash_resp.json.return_value = {"status": "error", "message": "Server Offline"}

        # Keep2Share calls: createFileByHash succeeds
        k2s_hash_resp = MagicMock()
        k2s_hash_resp.status_code = 200
        k2s_hash_resp.json.return_value = {
            "status": "success",
            "id": "k2s123",
            "link": "https://k2s.cc/file/k2s123"
        }

        mock_post.side_effect = [fb_hash_resp, fb_hash_resp, k2s_hash_resp]

        res = k2s_uploader.upload_file_dual(self.test_file.name)

        self.assertIsNotNone(res)
        self.assertEqual(res["service"], "K2S")
        self.assertEqual(res["link"], "https://k2s.cc/file/k2s123")
        self.assertTrue(res["instant"])

if __name__ == '__main__':
    unittest.main()
