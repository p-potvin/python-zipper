import os
import sys
import json
import struct
import subprocess

LOG_FILE = r"C:\Users\Administrator\Desktop\Github Repos\python-zipper\extension\public\native_host.log"

def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass

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
    log("Native host invoked.")
    try:
        msg = read_message()
        log(f"Received message: {json.dumps(msg)}")
        if msg and "folderPath" in msg:
            raw_path = msg["folderPath"]
            # Normalize path
            path = os.path.normpath(raw_path)
            log(f"Normalized path: {path}")

            if not os.path.exists(path):
                log(f"Path does not exist: {path}")
                send_message({"status": "error", "error": "Path does not exist", "path": path})
            else:
                if os.path.isfile(path):
                    log("Path is a file. Launching explorer with /select,...")
                    subprocess.Popen(['explorer', '/select,', path])
                else:
                    log("Path is a directory. Launching explorer on directory...")
                    subprocess.Popen(['explorer', path])
                send_message({"status": "success", "path": path})
        else:
            log("No folderPath in message or message is empty")
            send_message({"status": "error", "error": "Invalid message format"})
    except Exception as e:
        log(f"Exception occurred in native host: {str(e)}")
        send_message({"status": "error", "error": str(e)})