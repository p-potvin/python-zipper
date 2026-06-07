#!/usr/bin/env python3
"""Test JSON link extraction from Telegram exports"""

import os
import json
import re

def extract_links_from_telegram_json(json_file):
    """Extract all HTTP/HTTPS links from Telegram chat export JSON"""
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        extracted = set()
        
        if not isinstance(data, dict) or 'messages' not in data:
            print(f"   [WARN] Invalid JSON format: {json_file}")
            return extracted
        
        messages = data.get('messages', [])
        print(f"   [INFO] Scanning {len(messages)} messages from {json_file}...")
        
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            
            # Check 'text' field (can be list or string)
            text_field = msg.get('text', [])
            
            if isinstance(text_field, list):
                # text is an array of entities
                for entity in text_field:
                    if isinstance(entity, dict):
                        if entity.get('type') == 'link':
                            link = entity.get('text', '')
                            if link.startswith('http'):
                                extracted.add(link)
                    elif isinstance(entity, str):
                        # Plain text - extract URLs with regex
                        urls = re.findall(r'https?://[^\s]+', entity)
                        for url in urls:
                            extracted.add(url.rstrip(')'))
            
            elif isinstance(text_field, str) and text_field:
                # text is a plain string
                urls = re.findall(r'https?://[^\s]+', text_field)
                for url in urls:
                    extracted.add(url.rstrip(')'))
        
        return extracted
    
    except Exception as e:
        print(f"   [ERROR] Failed to parse {json_file}: {e}")
        return set()

# Test the extraction
json_exports = [
    r"C:\Users\Administrator\Desktop\Telegram\ChatExport_2026-05-28 (1)\result.json",
    r"C:\Users\Administrator\Desktop\Telegram\ChatExport_2026-05-28\result.json"
]

print("=" * 70)
print("Telegram JSON Link Extraction Test")
print("=" * 70)

all_links = set()

for json_file in json_exports:
    if os.path.exists(json_file):
        print(f"\n[1] Processing: {os.path.basename(json_file)}")
        links = extract_links_from_telegram_json(json_file)
        all_links.update(links)
        
        if links:
            print(f"[2] Found {len(links)} links:")
            for i, link in enumerate(sorted(links)[:5], 1):  # Show first 5
                print(f"    [{i}] {link[:70]}...")
            if len(links) > 5:
                print(f"    ... and {len(links) - 5} more")
        else:
            print(f"[2] No links found")
    else:
        print(f"\n[SKIP] File not found: {json_file}")

print(f"\n{'=' * 70}")
print(f"[TOTAL] {len(all_links)} unique links extracted from all exports")
print(f"{'=' * 70}")

# Show sample of links by type
print("\n[LINK TYPES]:")
types = {}
for link in all_links:
    if 'mega.nz' in link:
        types['MEGA'] = types.get('MEGA', 0) + 1
    elif 'linkvertise' in link or 'link-target' in link or 'link.php' in link:
        types['Linkvertise'] = types.get('Linkvertise', 0) + 1
    elif 't.me' in link:
        types['Telegram'] = types.get('Telegram', 0) + 1
    elif 'rentry.co' in link:
        types['Rentry'] = types.get('Rentry', 0) + 1
    else:
        types['Other'] = types.get('Other', 0) + 1

for link_type, count in sorted(types.items(), key=lambda x: x[1], reverse=True):
    print(f"  {link_type}: {count}")

if all_links:
    print(f"\n[OUTPUT] Would save to: telegram/output/pre_linkvertise_links.txt")
