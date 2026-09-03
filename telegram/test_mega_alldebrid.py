"""
CLI Test Tool for AllDebrid MEGA Link Unlocking & M3U Playlist Generation.

Usage:
  python telegram/test_mega_alldebrid.py --check-auth
  python telegram/test_mega_alldebrid.py --url "https://mega.nz/folder/..."
  python telegram/test_mega_alldebrid.py --demo
"""

import os
import sys
import argparse

# Add parent directory to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tlr_alldebrid import (
    get_alldebrid_token,
    check_alldebrid_auth,
    unlock_link_alldebrid,
    extract_redirector_links_alldebrid,
    generate_m3u_playlist,
    process_mega_folder_alldebrid,
    process_mega_url,
)
from tlr_config import PLAYLISTS_DIR, OUTPUT_DIR


def main():
    parser = argparse.ArgumentParser(description="Test AllDebrid MEGA Link Resolver & M3U Generator")
    parser.add_argument("--url", type=str, help="MEGA folder or file URL to process")
    parser.add_argument("--title", type=str, help="Telegram post title for smart naming")
    parser.add_argument("--check-auth", action="store_true", help="Check AllDebrid API key status")
    parser.add_argument("--demo", action="store_true", help="Run a demo test of M3U playlist generation with smart naming")
    args = parser.parse_args()

    token = get_alldebrid_token()
    print("=" * 60)
    print("AllDebrid MEGA Link & M3U Playlist Tester")
    print("=" * 60)
    print(f"Token Loaded: {'✓ Yes (' + token[:4] + '...' + token[-4:] + ')' if token else '✗ No token found'}")
    print(f"Playlists Directory: {PLAYLISTS_DIR}")

    if args.check_auth:
        print("\nChecking AllDebrid API authentication...")
        valid, info = check_alldebrid_auth()
        if valid:
            print(f"✓ Authentication SUCCESSFUL!")
            print(f"  Username: {info.get('username')}")
            print(f"  Premium: {info.get('isPremium')}")
            print(f"  Expires: {info.get('premiumUntil')}")
        else:
            print(f"✗ Authentication FAILED: {info.get('error')}")
            print("\nNote: You can update your API key in C:\\Users\\Administrator\\Desktop\\Github Repos\\.access\\alldebrid.token.txt")
        return

    if args.demo:
        demo_title = args.title or "🔥 Alex Adams & Jane Doe - Crazy Weekend 🔥"
        print(f"\n[DEMO MODE] Testing smart naming with Telegram title: {demo_title}")
        dummy_items = [
            {
                "link": "https://debrid.stream.local/dl/sample01/cryptic_raw_name_1080p (1).mp4",
                "filename": "cryptic_raw_name_1080p (1).mp4",
                "filesize": 104857600,
                "host": "mega",
                "id": "sample01"
            },
            {
                "link": "https://debrid.stream.local/dl/sample02/random_hash_720p (02).mkv",
                "filename": "random_hash_720p (02).mkv",
                "filesize": 314572800,
                "host": "mega",
                "id": "sample02"
            },
            {
                "link": "https://debrid.stream.local/dl/sample03/bonus_clip.mp4",
                "filename": "bonus_clip.mp4",
                "filesize": 52428800,
                "host": "mega",
                "id": "sample03"
            }
        ]
        m3u_path, json_path = generate_m3u_playlist(
            dummy_items,
            title="Demo Collection",
            telegram_title=demo_title
        )
        print(f"\n✓ Generated M3U File: {m3u_path}")
        print(f"✓ Generated JSON Manifest: {json_path}")
        print("\n--- M3U File Content ---")
        with open(m3u_path, "r", encoding="utf-8") as f:
            print(f.read())
        return

    if args.url:
        print(f"\nProcessing URL: {args.url}")
        res = process_mega_url(args.url, output_dir=OUTPUT_DIR, playlists_dir=PLAYLISTS_DIR, custom_title=args.title)
        print("\nResult:")
        print(f"Status: {res.get('status')}")
        if res.get("status") == "success":
            print(f"Title: {res.get('title')}")
            print(f"Playlist Path: {res.get('playlist_path')}")
            print(f"JSON Manifest: {res.get('json_path')}")
            print(f"Total Streams: {res.get('total_items')}")
            for it in res.get("items", []):
                print(f"  - {it.get('filename')} ({it.get('filesize', 0)/(1024**2):.1f} MB) -> {it.get('link')}")
        else:
            print(f"Error: {res.get('error')}")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
