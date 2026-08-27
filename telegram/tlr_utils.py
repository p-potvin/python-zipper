"""
Utility functions extracted from telethon_link_resolver.py.
Provides URL resolution, filename generation, notifications, and shared constants.
"""

import os
import re
import datetime
import hashlib
import requests
from urllib.parse import urlparse, unquote


def resolve_initial_url(url):
    """Follows URL shorteners to find the underlying URL before processing."""
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        response = requests.head(url, allow_redirects=True, headers=headers, timeout=10)
        if response.status_code >= 400:
            response = requests.get(url, allow_redirects=True, headers=headers, timeout=10)
        return response.url
    except Exception:
        return url


def send_notification(title, message, duration=5, output_dir=None):
    """Send Windows toast notification (threaded, non-blocking)"""
    try:
        import win11toast
        icon_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "logo-redcloud-transparent.png")
        buttons = []
        if output_dir:
            buttons = [{"label": "Open Output Folder", "callback": lambda: os.startfile(output_dir)}]
        win11toast.notify(title, message, duration=duration, icon=icon_path, buttons=buttons)
    except Exception:
        pass


def guess_file_extension_from_url(url):
    """Guess file extension from URL content-type or path"""
    common_extensions = {
        'video': ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm'],
        'audio': ['.mp3', '.aac', '.flac', '.wav', '.m4a', '.ogg'],
        'archive': ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso'],
        'document': ['.pdf', '.docx', '.xlsx', '.txt', '.doc', '.ppt'],
        'image': ['.jpg', '.png', '.gif', '.bmp', '.webp'],
    }

    try:
        path = urlparse(url).path.lower()
        for exts in common_extensions.values():
            for ext in exts:
                if ext in path:
                    return ext
    except Exception:
        pass

    return '.bin'


def generate_safe_filename(url_or_name, prefix="download"):
    """Generate a safe, descriptive filename from URL or name"""
    try:
        if url_or_name.startswith('http'):
            parsed = urlparse(url_or_name)
            path = unquote(parsed.path)
            filename = path.split('/')[-1]
            if filename and len(filename) > 3:
                return filename

        if len(url_or_name) > 5 and '/' not in url_or_name:
            safe_name = re.sub(r'[<>:"/\\|?*]', '_', url_or_name)
            if len(safe_name) > 3:
                return safe_name
    except Exception:
        pass

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    url_hash = hashlib.md5(url_or_name.encode()).hexdigest()[:6]
    return f"{prefix}_{timestamp}_{url_hash}"


def add_file_extension_to_name(filename, url=""):
    """Ensure filename has proper file extension"""
    if '.' in filename:
        ext = filename.split('.')[-1].lower()
        if 2 <= len(ext) <= 5:
            return filename

    if url:
        guessed_ext = guess_file_extension_from_url(url)
        if guessed_ext and guessed_ext != '.bin':
            return filename + guessed_ext

    if '.' not in filename:
        return filename + '.bin'

    return filename
