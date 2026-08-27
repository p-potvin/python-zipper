import io
import json
import struct
import unittest

import native_host


def encode_message(message):
    payload = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


def decode_message(data):
    length = struct.unpack("<I", data[:4])[0]
    return json.loads(data[4 : 4 + length].decode("utf-8"))


class NativeHostTests(unittest.TestCase):
    def test_round_trips_native_message_framing(self):
        stream = io.BytesIO(encode_message({"action": "reveal", "path": r"C:\sample.txt"}))
        self.assertEqual(native_host.read_message(stream), {"action": "reveal", "path": r"C:\sample.txt"})
        output = io.BytesIO()
        native_host.write_message(output, {"ok": True, "status": "revealed"})
        self.assertEqual(decode_message(output.getvalue()), {"ok": True, "status": "revealed"})

    def test_main_returns_structured_success(self):
        original = native_host.reveal_path
        native_host.reveal_path = lambda path: path
        try:
            output = io.BytesIO()
            native_host.main(io.BytesIO(encode_message({"action": "reveal", "path": r"C:\sample.txt"})), output)
        finally:
            native_host.reveal_path = original
        self.assertEqual(decode_message(output.getvalue()),
                         {"ok": True, "status": "revealed", "path": r"C:\sample.txt"})

    def test_rejects_unsupported_action(self):
        with self.assertRaises(native_host.NativeHostError) as raised:
            native_host.handle_message({"action": "launch", "path": r"C:\sample.txt"})
        self.assertEqual(raised.exception.code, "unsupported_action")

    def test_accepts_installed_v132_folder_path_message(self):
        response = native_host.handle_message({"folderPath": r"C:\sample.txt"}, lambda path: path)
        self.assertEqual(response, {"ok": True, "status": "revealed", "path": r"C:\sample.txt"})

    def test_rejects_oversized_frame(self):
        with self.assertRaises(native_host.NativeHostError) as raised:
            native_host.read_message(io.BytesIO(struct.pack("<I", native_host.MAX_MESSAGE_BYTES + 1)))
        self.assertEqual(raised.exception.code, "invalid_frame")

    def test_propagates_reveal_validation_error(self):
        def fail(_path):
            raise native_host.NativeHostError("path_not_found", "The supplied path does not exist")
        with self.assertRaises(native_host.NativeHostError) as raised:
            native_host.handle_message({"action": "reveal", "path": r"C:\missing.txt"}, fail)
        self.assertEqual(raised.exception.code, "path_not_found")


if __name__ == "__main__":
    unittest.main()
