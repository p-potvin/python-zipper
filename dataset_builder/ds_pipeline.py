"""The batch download pipeline, extracted from the HTTP handler.

It was a method on ``ScraperHandler`` purely because that is where it grew; the
body never touched ``self``. Lifting it out is what lets the outbound worker run
the same code path as the legacy HTTP route, so there is one pipeline rather
than two that drift.
"""

import os
from urllib.parse import urljoin, urlparse

import scraper
from ds_config import DEST_DIR
from ds_jobs import update_job
from ds_helpers import (
    get_rd_token, get_ad_token, unrestrict_link_rd, unrestrict_link_alldebrid, bypass_linkvertise,
    download_direct_file, download_and_zip_images,
    NOMOS_MODEL_NAME, IMAGE_EXTENSIONS,
)


def download_and_process(page_url, raw_links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, job_id=None, stream_headers=None, rclone_enabled=False, link_kinds=None):
    from urllib.parse import urlparse
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    # Merge browser-captured headers (Referer/Cookie/User-Agent/Origin) from the
    # extension so authenticated streams resolve instead of 403'ing. These apply
    # to every link in the batch — the extension sends one stream per request.
    if stream_headers:
        for k, v in stream_headers.items():
            if v:
                headers[k] = v
    url_slug = scraper.get_url_slug(page_url)
    rd_token = get_rd_token()
    ad_token = get_ad_token()
    unique_urls = []
    seen = set()
    for u in raw_links:
        full_url = urljoin(page_url, u)
        if (full_url.startswith("http://") or full_url.startswith("https://")) and full_url not in seen:
            seen.add(full_url)
            unique_urls.append(full_url)
    print(f"[Server] Processing {len(unique_urls)} link(s)...")
    update_job(job_id, total_links=len(unique_urls), status="running")
    image_urls = []
    archives = []
    rclone_results = []
    for index, url in enumerate(unique_urls, start=1):
        resolved_url = url
        if any(domain in url.lower() for domain in ["linkvertise.com", "direct-link.net", "link-center.net", "link-hub.net", "link-target.net"]):
            resolved_url = bypass_linkvertise(url)
            print(f"[Server] Bypassed {url} -> {resolved_url}")
        final_url = resolved_url
        is_mega = "mega.nz" in resolved_url.lower() or "mega.co.nz" in resolved_url.lower()
        is_premium = any(domain in resolved_url.lower() for domain in [
            "keep2share.cc", "k2s.cc", "fileboom.me", "fboom.me",
            "rapidgator.net", "rg.to", "katfile.com", "tezfiles.com", "pixeldrain.com"
        ])
        if is_mega:
            final_url = unrestrict_link_alldebrid(resolved_url, ad_token)
            print(f"[Server] Unrestricted MEGA via AllDebrid {resolved_url} -> {final_url}")
        elif is_premium:
            final_url = unrestrict_link_rd(resolved_url, rd_token)
            print(f"[Server] Unrestricted {resolved_url} -> {final_url}")
        parsed = urlparse(final_url)
        clean_path = parsed.path.rstrip("/").lower()
        path_ext = os.path.splitext(clean_path)[1].strip(".")
        last_segment = clean_path.split("/")[-1] if "/" in clean_path else clean_path
        # Prefer the kind the extension observed. Guessing from the path
        # extension fails on any CDN that serves images from extension-less
        # URLs, and the failure is silent but expensive: every image falls
        # into the single-file branch below and nothing ever gets zipped.
        hinted_kind = (link_kinds or {}).get(url) or (link_kinds or {}).get(final_url)
        if hinted_kind:
            is_image = hinted_kind == "image"
        else:
            is_image = path_ext in IMAGE_EXTENSIONS or last_segment in IMAGE_EXTENSIONS
        if is_image:
            image_urls.append(final_url)
        else:
            direct_result = download_direct_file(final_url, headers, DEST_DIR, rclone_enabled)
            if direct_result.get("filename"):
                archives.append(direct_result["filename"])
                rclone_results.append(direct_result.get("rclone_remote", ""))
        update_job(job_id, processed_links=index, images_count=len(image_urls))
    if image_urls:
        if len(image_urls) == 1 and not upscale_enabled:
            direct_result = download_direct_file(image_urls[0], headers, DEST_DIR, rclone_enabled)
            if direct_result.get("filename"):
                archives.append(direct_result["filename"])
                rclone_results.append(direct_result.get("rclone_remote", ""))
        else:
            # Report fetch progress while zipping. Without this the job sat
            # at "running" for the whole download with no visible movement,
            # which reads as a hang on a large gallery.
            def _zip_progress(jid, done, total):
                update_job(jid, processed_links=done, total_links=total)

            zip_result = download_and_zip_images(
                url_slug, page_url, image_urls, batch_size, headers,
                upscale_enabled, upscale_model, DEST_DIR, scraper.download_image,
                rclone_enabled, job_id=job_id, progress_fn=_zip_progress
            )
            archives.extend(zip_result.get("archives", []))
            rclone_results.extend(zip_result.get("rclone_results", []))
            update_job(job_id, images_count=zip_result.get("images_count", len(image_urls)))
    # Which remotes actually took something, in the order they were used. A
    # job whose files went to two different remotes is a normal outcome when
    # the first one fills up, and reporting only a boolean hid that entirely.
    landed = [r for r in rclone_results if r]
    return {
        "archives": archives,
        "rclone_complete": bool(rclone_results) and all(rclone_results),
        "rclone_remotes": sorted(set(landed)),
        "local_dir": DEST_DIR,
    }
