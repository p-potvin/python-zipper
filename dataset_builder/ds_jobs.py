"""
Job management functions extracted from dataset_builder/server.py.
Handles job creation, updates, completion, failure, and snapshot.
"""

import time
import uuid
import threading

JOBS = {}
JOBS_LOCK = threading.Lock()


def create_job(url, links, batch_size, upscale_enabled, upscale_model):
    now = int(time.time() * 1000)
    job_id = f"local-{uuid.uuid4().hex[:12]}"
    job = {
        "id": job_id,
        "status": "queued",
        "url": url,
        "total_links": len(links),
        "processed_links": 0,
        "images_count": 0,
        "archives": [],
        "batch_size": batch_size,
        "upscale_enabled": bool(upscale_enabled),
        "upscale_model": upscale_model,
        "rclone_complete": False,
        "created_at": now,
        "updated_at": now,
        "source": "local-python-zipper",
    }
    with JOBS_LOCK:
        if len(JOBS) >= 30:
            sorted_keys = sorted(JOBS.keys(), key=lambda k: JOBS[k].get("created_at", 0))
            for k in sorted_keys[:(len(JOBS) - 29)]:
                del JOBS[k]
        JOBS[job_id] = job
    return job_id


def update_job(job_id, **changes):
    if not job_id:
        return
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(changes)
        job["updated_at"] = int(time.time() * 1000)


def complete_job(job_id, archives=None, rclone_complete=False):
    update_job(
        job_id,
        status="completed",
        archives=list(archives or []),
        rclone_complete=bool(rclone_complete),
    )
    try:
        from win11toast import toast
        toast("Python Zipper Job Complete", f"Job {job_id[:12]} completed successfully.", duration="short")
    except Exception as e:
        print(f"[Server] Failed to send complete toast: {e}")


def fail_job(job_id, error):
    update_job(job_id, status="failed", error=str(error))
    try:
        from win11toast import toast
        toast("Python Zipper Job Failed", f"Job {job_id[:12]} failed: {error}", duration="short")
    except Exception as e:
        print(f"[Server] Failed to send fail toast: {e}")


def get_jobs_snapshot():
    with JOBS_LOCK:
        return {key: dict(value) for key, value in JOBS.items()}
