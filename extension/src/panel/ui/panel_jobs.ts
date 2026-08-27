// @ts-nocheck -- vendored from ../../userscript/src, extended for stream jobs & unified downloads
import { Api } from '../api';
import { globalState } from '../utils/state';
import { logToConsole } from '../utils/config';
import { showBrowserNotification } from '../main';
import { getLocalJobs, deleteLocalJob } from './local_jobs';

export async function fetchJobsFromEndpoints() {
    const mergedJobs = {};
    let jobOrigin = Api.origin;
    let downloadDir = '';
    for (const endpointKey of ["primary", "local", "localhost"]) {
        const response = await Api.send("jobs", "GET", null, endpointKey);
        if (!response.ok) continue;
        let data = {};
        try { data = await response.json(); } catch (_e) { data = {}; }
        if (data.jobs && Object.keys(data.jobs).length > 0) {
            Object.assign(mergedJobs, data.jobs);
            jobOrigin = response.origin || jobOrigin;
        }
        if (data.download_dir) downloadDir = data.download_dir;
    }
    return { jobs: mergedJobs, origin: jobOrigin, downloadDir };
}

function fmtBytes(n) {
    if (!n || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}

function fmtDuration(sec) {
    if (!sec || sec <= 0) return '';
    const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function statusColor(status) {
    return status === 'running' || status === 'in_progress' ? '#60a5fa'
        : status === 'completed' || status === 'complete' ? '#22c55e'
        : status === 'aborted' ? '#f59e0b'
        : status === 'queued' ? '#94a3b8'
        : '#ef4444';
}

function renderStreamJob(key, job) {
    const color = statusColor(job.status);
    const percent = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
    const dl = fmtBytes(job.downloaded_bytes);
    const total = fmtBytes(job.total_bytes);
    const speed = job.speed ? `${fmtBytes(job.speed)}/s` : '';
    const eta = (job.eta && job.status === 'running') ? `ETA ${fmtDuration(job.eta)}` : '';
    const running = job.status === 'running' || job.status === 'queued';
    const isStarting = running && percent === 0;
    const barWidth = isStarting ? 8 : percent;
    const displayPercent = isStarting ? (job.downloaded_bytes ? `${dl}` : 'Starting…') : `${percent}%`;
    const title = esc(job.title || job.stream_url || key);
    const thumb = job.thumbnail
        ? `<img src="${esc(job.thumbnail)}" referrerpolicy="no-referrer" style="width:72px;height:40px;object-fit:cover;border-radius:4px;flex:0 0 auto;background:#000;" onerror="this.style.display='none'">`
        : '';

    return `
    <div class="zipper-job-item" style="border:1px solid rgba(255,255,255,0.06);padding:8px;border-radius:6px;background:rgba(0,0,0,0.18);margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;">
            <span style="font-weight:700;color:var(--zipper-primary);">🔴 STREAM</span>
            <span style="color:${color};font-weight:bold;font-size:10px;text-transform:uppercase;">${job.status}</span>
        </div>
        <div style="display:flex;gap:8px;">
            ${thumb}
            <div style="flex:1;min-width:0;">
                <div style="font-size:11px;color:var(--zipper-text,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${title}">${title}</div>
                <div style="font-size:9px;color:var(--zipper-text-muted,#888);margin-top:2px;">
                    ${job.quality && job.quality !== 'best' ? `quality: ${esc(job.quality)} · ` : ''}${[dl, total].filter(Boolean).join(' / ')} ${speed} ${eta}
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                    <div style="flex:1;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
                        <div style="width:${barWidth}%;height:100%;background:${color};transition:width .3s;"></div>
                    </div>
                    <span style="font-size:10px;font-weight:bold;min-width:30px;text-align:right;">${displayPercent}</span>
                </div>
            </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end;flex-wrap:wrap;">
            ${running ? `<button class="zipper-stream-stop zipper-btn" data-job="${key}" style="padding:2px 8px;font-size:10px;height:20px;background:#f59e0b;border:none;box-shadow:none;color:#231400;">Stop</button>` : ''}
            ${(job.status === 'completed' && job.save_path) ? `<button class="zipper-stream-open zipper-btn" data-path="${(job.save_path || '').replace(/"/g, '&quot;')}" style="padding:2px 8px;font-size:10px;height:20px;background:var(--zipper-primary);border:none;box-shadow:none;color:#fff;">📂 Open</button>` : ''}
            <button class="zipper-stream-delete zipper-btn" data-job="${key}" style="padding:2px 8px;font-size:10px;height:20px;background:#7f1d1d;border:none;box-shadow:none;color:#fecaca;">Delete</button>
        </div>
    </div>`;
}

function renderBatchJob(key, job, jobOrigin, downloadDir) {
    const color = statusColor(job.status);
    const percent = job.total_links > 0 ? Math.min(100, Math.round((job.processed_links / job.total_links) * 100)) : 0;
    const running = job.status === 'running' || job.status === 'queued';
    const isStarting = running && percent === 0;
    const barWidth = isStarting ? 8 : percent;
    const displayPercent = isStarting ? 'Starting…' : `${percent}%`;
    const finished = !running;
    const badge = job.rclone_enabled ? '☁️ CLOUD RCLONE' : '⚡ SERVER BATCH';
    const saveLocation = job.save_dir || downloadDir || '.downloaded';

    return `
        <div class="zipper-job-item" style="border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.15); margin-bottom: 6px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                <span class="zipper-job-id" style="font-family: monospace; color: var(--zipper-primary);" title="${key}">
                    <strong style="color:var(--zipper-primary);">${badge}</strong> ${key.substring(0, 10)}...
                </span>
                <span style="color: ${color}; font-weight: bold; font-size: 10px; text-transform: uppercase;">${job.status}</span>
            </div>
            <div style="font-size: 10px; color: var(--zipper-text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 4px;" title="${job.url}">
                Source: ${job.url}
            </div>
            <div style="font-size: 9px; color: var(--zipper-text-muted); margin-bottom: 6px;">
                📁 Location: <code>${esc(saveLocation)}</code>
            </div>
            ${job.upscale_enabled ? `<div style="font-size: 9px; color: var(--zipper-accent); margin-bottom: 4px;"><strong>Upscaling:</strong> ${job.upscale_model}</div>` : ''}
            <div style="display: flex; align-items: center; gap: 8px;">
                <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                    <div style="width: ${barWidth}%; height: 100%; background: ${color}; transition: width 0.3s;"></div>
                </div>
                <span style="font-size: 10px; font-weight: bold; min-width: 24px; text-align: right;">${displayPercent}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--zipper-text-muted); margin-top: 4px; align-items: center;">
                <span>Processed: ${job.processed_links}/${job.total_links}</span>
                <span>Media zipped: ${job.images_count || 0}</span>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center;">
                ${running ? `<button class="zipper-job-abort zipper-btn" data-job="${key}" style="padding:2px 8px;font-size:10px;height:20px;background:#f59e0b;border:none;box-shadow:none;color:#231400;cursor:pointer;">Abort</button>` : ''}
                ${job.status === 'completed' ? `
                    ${job.archives && job.archives.length > 0 ? job.archives.map((arch, index) => {
                        const archivePath = job.archive_paths?.[index]
                            || `${job.save_dir || downloadDir || ''}\\${arch}`.replace(/^\\/, '');
                        const downloadUrl = `${jobOrigin}/api/download-file?path=${encodeURIComponent(archivePath || arch)}`;
                        return `
                        <div style="display: inline-flex; border: 1px solid var(--zipper-border); border-radius: 4px; overflow: hidden; background: rgba(0,0,0,0.2);">
                            <a href="${esc(downloadUrl)}" target="_blank" class="zipper-view-link zipper-btn" style="text-decoration: none; padding: 2px 6px; font-size: 9px; height: 18px; line-height: 18px; font-weight: normal; background: var(--zipper-primary); color: #fff; box-shadow: none; border: none; border-radius: 0;">
                                View ${arch.split('_').pop() || 'File'}
                            </a>
                            <button class="zipper-open-btn zipper-btn" data-path="${esc(archivePath)}" title="Locate in Desktop Explorer" style="padding: 2px 4px; font-size: 9px; height: 18px; font-weight: normal; background: rgba(255,255,255,0.08); border: none; border-left: 1px solid var(--zipper-border); border-radius: 0; box-shadow: none;">
                                📂
                            </button>
                        </div>
                    `}).join('') : ''}
                    <button class="zipper-open-folder-btn zipper-btn" data-path="${esc(job.save_dir || downloadDir || '')}" style="padding: 2px 6px; font-size: 9px; height: 20px; font-weight: normal; background: rgba(255,255,255,0.08); border: 1px solid var(--zipper-border); box-shadow: none;">
                        Open Folder
                    </button>
                ` : ''}
                ${finished ? `<button class="zipper-job-delete zipper-btn" data-job="${key}" style="padding:2px 8px;font-size:10px;height:20px;background:#7f1d1d;border:none;box-shadow:none;color:#fecaca;cursor:pointer;">Delete</button>` : ''}
            </div>
        </div>`;
}

function renderLocalZipJob(key, job) {
    const color = statusColor(job.status);
    const percent = job.progress || (job.total_links > 0 ? Math.min(100, Math.round((job.processed_links / job.total_links) * 100)) : 0);
    const running = job.status === 'running';
    const barWidth = running && percent === 0 ? 8 : percent;
    const displayPercent = running && percent === 0 ? 'Starting…' : `${percent}%`;

    return `
        <div class="zipper-job-item" style="border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.15); margin-bottom: 6px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                <span style="font-weight: 700; color: #a78bfa;">📦 LOCAL ZIP</span>
                <span style="color: ${color}; font-weight: bold; font-size: 10px; text-transform: uppercase;">${job.status}</span>
            </div>
            <div style="font-size: 10px; color: var(--zipper-text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 4px;" title="${job.url}">
                Source: ${job.url}
            </div>
            <div style="font-size: 9px; color: var(--zipper-text-muted); margin-bottom: 6px;">
                📁 Location: <code>${job.save_dir || 'Browser Downloads Folder'}</code>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                    <div style="width: ${barWidth}%; height: 100%; background: ${color}; transition: width 0.3s;"></div>
                </div>
                <span style="font-size: 10px; font-weight: bold; min-width: 24px; text-align: right;">${displayPercent}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--zipper-text-muted); margin-top: 4px; align-items: center;">
                <span>Processed: ${job.processed_links || 0}/${job.total_links || 0}</span>
                <span>Archives: ${job.archives ? job.archives.length : 0}</span>
            </div>
            ${job.archives && job.archives.length > 0 ? `
                <div style="font-size: 9px; color: var(--zipper-text-muted); margin-top: 4px; display:flex; flex-wrap:wrap; gap:4px;">
                    ${job.archives.map(a => `<span style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;">${esc(a)}</span>`).join('')}
                </div>
            ` : ''}
            <div style="display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center;">
                <button class="zipper-local-job-delete zipper-btn" data-job="${key}" style="padding:2px 8px;font-size:10px;height:20px;background:#7f1d1d;border:none;box-shadow:none;color:#fecaca;cursor:pointer;">Delete</button>
            </div>
        </div>`;
}

function renderBrowserDownloadJob(dl) {
    const color = statusColor(dl.state);
    const percent = dl.totalBytes > 0 ? Math.min(100, Math.round((dl.bytesReceived / dl.totalBytes) * 100)) : (dl.state === 'complete' ? 100 : 0);
    const displayPercent = dl.state === 'complete' ? '100%' : (dl.totalBytes > 0 ? `${percent}%` : fmtBytes(dl.bytesReceived));
    const filename = dl.filename.split(/[\\/]/).pop() || dl.filename || 'download';

    return `
        <div class="zipper-job-item" style="border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.15); margin-bottom: 6px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                <span style="font-weight: 700; color: #38bdf8;">🌐 BROWSER DL</span>
                <span style="color: ${color}; font-weight: bold; font-size: 10px; text-transform: uppercase;">${dl.state}</span>
            </div>
            <div style="font-size: 10px; color: var(--zipper-text); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 2px;" title="${dl.filename}">
                ${esc(filename)}
            </div>
            <div style="font-size: 9px; color: var(--zipper-text-muted); margin-bottom: 6px;">
                📁 Location: <code>${esc(dl.filename || 'Downloads/python-zipper')}</code>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                    <div style="width: ${percent}%; height: 100%; background: ${color}; transition: width 0.3s;"></div>
                </div>
                <span style="font-size: 10px; font-weight: bold; min-width: 24px; text-align: right;">${displayPercent}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--zipper-text-muted); margin-top: 4px; align-items: center;">
                <span>${[fmtBytes(dl.bytesReceived), fmtBytes(dl.totalBytes)].filter(Boolean).join(' / ')}</span>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center;">
                <button class="zipper-browser-dl-reveal zipper-btn" data-id="${dl.id}" data-path="${esc(dl.filename)}" style="padding: 2px 8px; font-size: 10px; height: 20px; font-weight: normal; background: var(--zipper-primary); color:#fff; border: none; box-shadow: none;">
                    📂 Open in Explorer
                </button>
            </div>
        </div>`;
}

export async function refreshJobs(dashboardSection: HTMLElement, previousJobStatuses: Record<string, string>) {
    const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');
    if (!jobsListContainer) return;

    let serverJobs = {};
    let jobOrigin = Api.origin;
    let downloadDir = '';

    // 1. Fetch server jobs if server is online
    if (globalState.serverOnline) {
        try {
            const fetched = await fetchJobsFromEndpoints();
            serverJobs = fetched.jobs || {};
            jobOrigin = fetched.origin || jobOrigin;
            downloadDir = fetched.downloadDir || '';
        } catch (_) { }
    }

    // 2. Fetch local zipping jobs
    const localJobs = getLocalJobs();

    // 3. Fetch browser downloads from background
    let browserDownloads = [];
    const extAPI = (globalThis as any).browser ?? (globalThis as any).chrome;
    if (extAPI && extAPI.runtime) {
        try {
            const res = await extAPI.runtime.sendMessage({ kind: 'downloads:list' });
            if (res && res.ok && Array.isArray(res.downloads)) {
                browserDownloads = res.downloads;
            }
        } catch (_) { }
    }

    // Notify on completed server jobs
    for (const key in serverJobs) {
        const job = serverJobs[key];
        const prevStatus = previousJobStatuses[key];
        if (prevStatus && prevStatus !== 'completed' && job.status === 'completed') {
            showBrowserNotification("Job Complete", `Job ${key.substring(0, 12)} completed successfully!`);
        }
        previousJobStatuses[key] = job.status;
    }

    const renderedItems: { timestamp: number; html: string }[] = [];

    // Add server jobs
    for (const key in serverJobs) {
        const job = serverJobs[key];
        const ts = job.created_at || 0;
        const html = job.type === 'stream' ? renderStreamJob(key, job) : renderBatchJob(key, job, jobOrigin, downloadDir);
        renderedItems.push({ timestamp: typeof ts === 'number' ? ts * 1000 : Date.now(), html });
    }

    // Add local zipping jobs
    for (const key in localJobs) {
        const job = localJobs[key];
        const ts = job.created_at || Date.now();
        renderedItems.push({ timestamp: ts, html: renderLocalZipJob(key, job) });
    }

    // Add browser API downloads
    for (const dl of browserDownloads) {
        const ts = dl.startTime ? new Date(dl.startTime).getTime() : Date.now();
        renderedItems.push({ timestamp: ts, html: renderBrowserDownloadJob(dl) });
    }

    if (renderedItems.length === 0) {
        jobsListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No active or recent jobs found.</div>';
        return;
    }

    renderedItems.sort((a, b) => b.timestamp - a.timestamp);
    jobsListContainer.innerHTML = renderedItems.map(item => item.html).join('');
}

export function setupJobsListClickHandler(jobsListContainer: HTMLElement) {
    const flashRevealError = (button) => {
        button.classList.remove('zipper-reveal-error');
        void button.offsetWidth;
        button.classList.add('zipper-reveal-error');
        setTimeout(() => button.classList.remove('zipper-reveal-error'), 1600);
    };
    const revealPath = async (button, path) => {
        const extAPI = (globalThis as any).browser ?? (globalThis as any).chrome;
        if (!path || !extAPI?.runtime) {
            flashRevealError(button);
            return false;
        }
        try {
            const response = await extAPI.runtime.sendMessage({ kind: 'open:path', path });
            if (response?.ok) return true;
        } catch (error) {
            console.error('[Jobs] File Explorer reveal failed:', error);
        }
        flashRevealError(button);
        return false;
    };
    jobsListContainer.onclick = async (e) => {
        const stopBtn = e.target.closest('.zipper-stream-stop');
        const abortJobBtn = e.target.closest('.zipper-job-abort');
        const deleteJobBtn = e.target.closest('.zipper-job-delete');
        const streamDelBtn = e.target.closest('.zipper-stream-delete');
        const openStreamBtn = e.target.closest('.zipper-stream-open');
        const openFileBtn = e.target.closest('.zipper-open-btn');
        const openFolderBtn = e.target.closest('.zipper-open-folder-btn');
        const localDelBtn = e.target.closest('.zipper-local-job-delete');
        const browserRevealBtn = e.target.closest('.zipper-browser-dl-reveal');

        if (localDelBtn) {
            e.preventDefault();
            const jobId = localDelBtn.getAttribute('data-job');
            if (jobId) {
                deleteLocalJob(jobId);
                localDelBtn.closest('.zipper-job-item')?.remove();
            }
        } else if (browserRevealBtn) {
            e.preventDefault();
            const dId = parseInt(browserRevealBtn.getAttribute('data-id') || '0', 10);
            const path = browserRevealBtn.getAttribute('data-path') || '';
            const extAPI = (globalThis as any).browser ?? (globalThis as any).chrome;
            if (extAPI && extAPI.runtime) {
                try {
                    await extAPI.runtime.sendMessage({ kind: 'downloads:reveal', downloadId: dId, path });
                } catch (err) {
                    flashRevealError(browserRevealBtn);
                }
            }
        } else if (stopBtn) {
            e.preventDefault();
            stopBtn.disabled = true; stopBtn.textContent = 'Stopping…';
            await Api.send("streamStop", "POST", { job_id: stopBtn.getAttribute('data-job') });
            logToConsole('[Stream] Stop requested.', 'info');
        } else if (abortJobBtn) {
            e.preventDefault();
            abortJobBtn.disabled = true; abortJobBtn.textContent = 'Aborting…';
            const jobId = abortJobBtn.getAttribute('data-job');
            const extAPI = (globalThis as any).browser ?? (globalThis as any).chrome;
            if (extAPI && extAPI.runtime) {
                await extAPI.runtime.sendMessage({ kind: 'jobs:stop', jobId });
            } else {
                await Api.send("streamStop", "POST", { job_id: jobId });
            }
        } else if (streamDelBtn) {
            e.preventDefault();
            await Api.send("streamDelete", "POST", { job_id: streamDelBtn.getAttribute('data-job') });
            streamDelBtn.closest('.zipper-job-item')?.remove();
        } else if (deleteJobBtn) {
            e.preventDefault();
            const jobId = deleteJobBtn.getAttribute('data-job');
            const extAPI = (globalThis as any).browser ?? (globalThis as any).chrome;
            if (extAPI && extAPI.runtime) {
                await extAPI.runtime.sendMessage({ kind: 'jobs:delete', jobId });
            } else {
                await Api.send("streamDelete", "POST", { job_id: jobId });
            }
            deleteJobBtn.closest('.zipper-job-item')?.remove();
        } else if (openStreamBtn) {
            e.preventDefault();
            openStreamBtn.style.opacity = '0.5';
            const path = openStreamBtn.getAttribute('data-path');
            await revealPath(openStreamBtn, path);
            openStreamBtn.style.opacity = '1';
        } else if (openFileBtn) {
            e.preventDefault();
            openFileBtn.style.opacity = '0.5';
            const path = openFileBtn.getAttribute('data-path');
            await revealPath(openFileBtn, path);
            openFileBtn.style.opacity = '1';
        } else if (openFolderBtn) {
            e.preventDefault();
            openFolderBtn.style.opacity = '0.5';
            const path = openFolderBtn.getAttribute('data-path');
            await revealPath(openFolderBtn, path);
            openFolderBtn.style.opacity = '1';
        }
    };
}
