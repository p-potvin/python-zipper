import sys
import os
sys.path.append(os.path.abspath('.'))
import requests
import proxy_utils
proxy_dict = proxy_utils.get_requests_proxies()
print(f'Proxy dict: {proxy_dict}')
try:
    resp = requests.get('https://api.ipify.org?format=json', proxies=proxy_dict, timeout=10)
    print(f'IP via proxy: {resp.json()}')
except Exception as e:
    print(f'Error: {e}')
