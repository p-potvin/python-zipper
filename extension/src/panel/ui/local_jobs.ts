// @ts-nocheck -- built by esbuild

export interface LocalJob {
    id: string;
    type: 'local_zip' | 'browser_dl';
    status: 'running' | 'completed' | 'failed' | 'aborted';
    url: string;
    created_at: number;
    total_links: number;
    processed_links: number;
    progress: number;
    archives: string[];
    save_dir?: string;
    error?: string;
    download_method?: string;
}

const localJobsMap = new Map<string, LocalJob>();

// Restore from local storage on module load
try {
    const raw = typeof GM_getValue !== 'undefined' ? GM_getValue('zipper-local-jobs', '') : '';
    if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            parsed.forEach(job => {
                if (job && job.id) localJobsMap.set(job.id, job);
            });
        }
    }
} catch (_) { }

function persistLocalJobs() {
    try {
        const arr = Array.from(localJobsMap.values()).slice(-50); // Keep last 50 jobs
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('zipper-local-jobs', JSON.stringify(arr));
        }
    } catch (_) { }
}

export function createLocalJob(totalLinks: number, pageUrl: string = (typeof window !== 'undefined' ? window.location.href : '')): string {
    const id = `loc_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const job: LocalJob = {
        id,
        type: 'local_zip',
        status: 'running',
        url: pageUrl,
        created_at: Date.now(),
        total_links: totalLinks,
        processed_links: 0,
        progress: 0,
        archives: [],
        download_method: 'Browser In-Memory Zip',
        save_dir: 'Browser Downloads Folder'
    };
    localJobsMap.set(id, job);
    persistLocalJobs();
    return id;
}

export function updateLocalJob(id: string, updates: Partial<LocalJob>) {
    const job = localJobsMap.get(id);
    if (!job) return;
    Object.assign(job, updates);
    if (updates.total_links && updates.processed_links !== undefined) {
        job.progress = Math.min(100, Math.round((job.processed_links / updates.total_links) * 100));
    }
    localJobsMap.set(id, job);
    persistLocalJobs();
}

export function completeLocalJob(id: string, archives: string[]) {
    const job = localJobsMap.get(id);
    if (!job) return;
    job.status = 'completed';
    job.progress = 100;
    job.processed_links = job.total_links;
    job.archives = archives;
    localJobsMap.set(id, job);
    persistLocalJobs();
}

export function failLocalJob(id: string, error: string) {
    const job = localJobsMap.get(id);
    if (!job) return;
    job.status = 'failed';
    job.error = error;
    localJobsMap.set(id, job);
    persistLocalJobs();
}

export function deleteLocalJob(id: string) {
    localJobsMap.delete(id);
    persistLocalJobs();
}

export function getLocalJobs(): Record<string, LocalJob> {
    const result: Record<string, LocalJob> = {};
    localJobsMap.forEach((val, key) => {
        result[key] = val;
    });
    return result;
}
