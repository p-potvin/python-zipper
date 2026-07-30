import sys
import json
import struct
import subprocess

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack('@I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)

def send_message(message_dict):
    encoded = json.dumps(message_dict).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

if __name__ == "__main__":
    msg = read_message()
    if msg and "folderPath" in msg:
        path = msg["folderPath"]
        # Open Explorer targeting the folder
        subprocess.Popen(['explorer', path])
        send_message({"status": "success"})