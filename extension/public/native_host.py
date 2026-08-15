import os
import sys
import json
import struct
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "native_host.log")

def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{msg}\n")
    except Exception:
        pass

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
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
        raw_path = (msg or {}).get("folderPath") or (msg or {}).get("path") or ""
        
        default_dir = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".downloaded", "streams"))
        if not os.path.exists(default_dir):
            default_dir = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".downloaded"))
        if not os.path.exists(default_dir):
            default_dir = os.path.expanduser("~/Downloads")

        target_path = os.path.normpath(raw_path) if raw_path else default_dir
        log(f"Normalized target path: {target_path}")

        curr = target_path
        while curr and not os.path.exists(curr):
            parent = os.path.dirname(curr)
            if parent == curr:
                break
            curr = parent
        if not curr or not os.path.exists(curr):
            curr = default_dir

        if os.path.exists(target_path):
            if os.path.isfile(target_path):
                log(f"Target is file: {target_path}. Launching explorer /select,...")
                subprocess.Popen(f'explorer /select,"{target_path}"', shell=True)
            else:
                log(f"Target is directory: {target_path}. Launching explorer...")
                subprocess.Popen(f'explorer "{target_path}"', shell=True)
            send_message({"ok": True, "status": "success", "path": target_path})
        else:
            log(f"Target does not exist directly, opening nearest parent folder: {curr}")
            subprocess.Popen(f'explorer "{curr}"', shell=True)
            send_message({"ok": True, "status": "success", "path": curr})
    except Exception as e:
        log(f"Exception occurred in native host: {str(e)}")
        send_message({"ok": False, "status": "error", "error": str(e)})