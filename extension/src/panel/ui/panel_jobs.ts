// @ts-nocheck -- vendored from ../../userscript/src, extended for stream jobs
import { Api } from '../api';
import { globalState } from '../utils/state';
import { logToConsole } from '../utils/config';
import { showBrowserNotification } from '../main';

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
    return status === 'running' ? '#60a5fa'
        : status === 'completed' ? '#22c55e'
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
    return `
        <div class="zipper-job-item" style="border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.15); margin-bottom: 6px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                <span class="zipper-job-id" style="font-family: monospace; color: var(--zipper-primary);" title="${key}">${key.substring(0, 15)}...</span>
                <span style="color: ${color}; font-weight: bold; font-size: 10px; text-transform: uppercase;">${job.status}</span>
            </div>
            <div style="font-size: 10px; color: var(--zipper-text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 6px;" title="${job.url}">
                Source: ${job.url}
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
                <span>Media zipped: ${job.images_count}</span>
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

export async function refreshJobs(dashboardSection: HTMLElement, previousJobStatuses: Record<string, string>) {
    if (!globalState.serverOnline) return;
    const { jobs, origin: jobOrigin, downloadDir } = await fetchJobsFromEndpoints();
    const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');

    for (const key in jobs) {
        const job = jobs[key];
        const prevStatus = previousJobStatuses[key];
        if (prevStatus && prevStatus !== 'completed' && job.status === 'completed') {
            showBrowserNotification("Job Complete", `Job ${key.substring(0, 12)} completed successfully!`);
        }
        previousJobStatuses[key] = job.status;
    }

    const jobKeys = Object.keys(jobs);
    if (jobKeys.length === 0) {
        jobsListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No active or recent jobs found.</div>';
        return;
    }
    jobKeys.sort((a, b) => jobs[b].created_at - jobs[a].created_at);
    jobsListContainer.innerHTML = jobKeys.map(key => {
        const job = jobs[key];
        return job.type === 'stream' ? renderStreamJob(key, job) : renderBatchJob(key, job, jobOrigin, downloadDir);
    }).join('');
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
        const delBtn = e.target.closest('.zipper-stream-delete');
        const abortJobBtn = e.target.closest('.zipper-job-abort');
        const deleteJobBtn = e.target.closest('.zipper-job-delete');
        const openStreamBtn = e.target.closest('.zipper-stream-open');
        const openFileBtn = e.target.closest('.zipper-open-btn');
        const openFolderBtn = e.target.closest('.zipper-open-folder-btn');

        if (stopBtn) {
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
            logToConsole(`[Job] Abort requested for ${jobId}.`, 'info');
        } else if (delBtn) {
            e.preventDefault();
            await Api.send("streamDelete", "POST", { job_id: delBtn.getAttribute('data-job') });
            delBtn.closest('.zipper-job-item')?.remove();
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
            const path = openFileBtn.getAttribute('data-path');
            openFileBtn.style.opacity = '0.5';
            await revealPath(openFileBtn, path);
            openFileBtn.style.opacity = '1';
        } else if (openFolderBtn) {
            e.preventDefault();
            const path = openFolderBtn.getAttribute('data-path');
            openFolderBtn.style.opacity = '0.5';
            await revealPath(openFolderBtn, path);
            openFolderBtn.style.opacity = '1';
        }
    };
}
