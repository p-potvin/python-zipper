import os
import sys
import tempfile

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from k2s_uploader import upload_file_dual

def main():
    print("=========================================================")
    print("LIVE DUAL UPLOADER VERIFICATION")
    print("=========================================================")
    
    # Create a small temp file
    fd, temp_path = tempfile.mkstemp(suffix=".txt", prefix="k2s_verify_")
    try:
        with os.fdopen(fd, 'w') as f:
            f.write("This is a live integration test for the FileBoom and Keep2Share automatic background uploader.")
            
        print(f"[INIT] Created temporary file: {temp_path}")
        print("[PROCESS] Initiating upload...")
        
        result = upload_file_dual(temp_path)
        
        if result:
            print("\n=========================================================")
            print("[SUCCESS] Live Upload Completed!")
            print(f"Service: {result['service']}")
            print(f"URL:     {result['link']}")
            print(f"Instant: {result['instant']}")
            print("=========================================================")
        else:
            print("\n[FAIL] Live upload returned None.")
            
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
            print("[CLEANUP] Deleted temporary file.")

if __name__ == '__main__':
    main()
