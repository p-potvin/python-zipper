import os
import urllib.parse
from dotenv import load_dotenv

load_dotenv()

# PROXY_URL handles TNLegend Tor Rotator (e.g. socks5://127.0.0.1:9050)
# and Web Unlocker (e.g. http://user:pass@host:port)
PROXY_URL = os.getenv("PROXY_URL", "")

def get_requests_proxies():
    """Returns proxy dictionary for Python Requests."""
    if not PROXY_URL:
        return None
    return {
        "http": PROXY_URL,
        "https": PROXY_URL
    }

def get_patchright_proxy():
    """Returns proxy dictionary for Patchright."""
    if not PROXY_URL:
        return None
    
    parsed = urllib.parse.urlparse(PROXY_URL)
    proxy_config = {
        "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
    }
    if parsed.username:
        proxy_config["username"] = parsed.username
    if parsed.password:
        proxy_config["password"] = parsed.password
        
    return proxy_config
