import { Api } from '../api';
import { globalState } from '../utils/state';
import { logToConsole } from '../utils/config';
import { showBrowserNotification } from '../main';

export async function fetchJobsFromEndpoints() {
    const mergedJobs = {};
    let jobOrigin = Api.origin;
    for (const endpointKey of ["primary", "local", "localhost"]) {
        const response = await Api.send("jobs", "GET", null, endpointKey);
        if (!response.ok) continue;
        let data = {};
        try { data = await response.json(); } catch (_e) { data = {}; }
        if (data.jobs && Object.keys(data.jobs).length > 0) {
            Object.assign(mergedJobs, data.jobs);
            jobOrigin = response.origin || jobOrigin;
        }
    }
    return { jobs: mergedJobs, origin: jobOrigin };
}

export async function refreshJobs(dashboardSection: HTMLElement, previousJobStatuses: Record<string, string>) {
    if (!globalState.serverOnline) return;
    const { jobs, origin: jobOrigin } = await fetchJobsFromEndpoints();
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
    } else {
        jobKeys.sort((a, b) => jobs[b].created_at - jobs[a].created_at);
        jobsListContainer.innerHTML = jobKeys.map(key => {
            const job = jobs[key];
            const statusColor = job.status === 'running' ? '#60a5fa' :
                job.status === 'completed' ? '#22c55e' :
                    job.status === 'aborted' ? '#f59e0b' : '#ef4444';

            const percent = job.total_links > 0 ? Math.min(100, Math.round((job.processed_links / job.total_links) * 100)) : 0;

            return `
                <div class="zipper-job-item" style="border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.15); margin-bottom: 6px;">
                    <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                        <span class="zipper-job-id" style="font-family: monospace; color: var(--zipper-primary);" title="${key}">${key.substring(0, 15)}...</span>
                        <span style="color: ${statusColor}; font-weight: bold; font-size: 10px; text-transform: uppercase;">${job.status}</span>
                    </div>
                    <div style="font-size: 10px; color: var(--zipper-text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 6px;" title="${job.url}">
                        Source: ${job.url}
                    </div>
                    ${job.upscale_enabled ? `<div style="font-size: 9px; color: var(--zipper-accent); margin-bottom: 4px;"><strong>Upscaling:</strong> ${job.upscale_model}</div>` : ''}
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                            <div style="width: ${percent}%; height: 100%; background: ${statusColor}; transition: width 0.3s;"></div>
                        </div>
                        <span style="font-size: 10px; font-weight: bold; min-width: 24px; text-align: right;">${percent}%</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--zipper-text-muted); margin-top: 4px; align-items: center;">
                        <span>Processed: ${job.processed_links}/${job.total_links}</span>
                        <span>Media zipped: ${job.images_count}</span>
                    </div>
                    ${job.status === 'completed' ? `
                        <div style="display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center;">
                            ${job.archives && job.archives.length > 0 ? job.archives.map(arch => `
                                <div style="display: inline-flex; border: 1px solid var(--zipper-border); border-radius: 4px; overflow: hidden; background: rgba(0,0,0,0.2);">
                                    <a href="#" data-file="${arch}" data-origin="${jobOrigin}" class="zipper-view-link zipper-btn" style="text-decoration: none; padding: 2px 6px; font-size: 9px; height: 18px; line-height: 18px; font-weight: normal; background: var(--zipper-primary); color: #fff; box-shadow: none; border: none; border-radius: 0;">
                                        View ${arch.split('_').pop() || 'File'}
                                    </a>
                                    <button class="zipper-open-btn zipper-btn" data-file="${arch}" title="Locate in Desktop Explorer" style="padding: 2px 4px; font-size: 9px; height: 18px; font-weight: normal; background: rgba(255,255,255,0.08); border: none; border-left: 1px solid var(--zipper-border); border-radius: 0; box-shadow: none;">
                                        📂
                                    </button>
                                </div>
                            `).join('') : ''}
                            <button class="zipper-open-folder-btn zipper-btn" style="padding: 2px 6px; font-size: 9px; height: 20px; font-weight: normal; background: rgba(255,255,255,0.08); border: 1px solid var(--zipper-border); box-shadow: none;">
                                Open Folder
                            </button>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }
}

export function setupJobsListClickHandler(jobsListContainer: HTMLElement) {
    jobsListContainer.onclick = async (e) => {
        const openFileBtn = e.target.closest('.zipper-open-btn');
        const openFolderBtn = e.target.closest('.zipper-open-folder-btn');
        const viewLink = e.target.closest('.zipper-view-link');

        if (viewLink) {
            e.preventDefault();
            const filename = viewLink.getAttribute('data-file');
            const jobOrigin = viewLink.getAttribute('data-origin') || Api.origin;
            viewLink.style.opacity = '0.5';
            const response = await Api.send("openDownloaded", "POST", { filename });
            viewLink.style.opacity = '1';
            let success = false;
            let filePath = null;
            if (response.ok) {
                try {
                    const data = await response.json();
                    if (data.status === 'opened file') success = true;
                    if (data.path) filePath = data.path;
                } catch (_) { }
            }
            if (!success) {
                if (filePath) {
					chrome.runtime.sendNativeMessage(
						"com.pythonzipper.flmgr",
				    { folderPath: "C:\Users\Administrator\Desktop\Github Repos\python-zipper\.downloaded" },
				    (response) => {
					if (chrome.runtime.lastError) {
					  console.warn("Native Messaging failed, falling back to localhost:", chrome.runtime.lastError.message);
					  triggerPythonFallback("C:\Users\Administrator\Desktop\Github Repos\python-zipper\.downloaded");
					} else {
					  console.log("Explorer opened via Native Messaging:", response);
					}
				  }
				);
					
                    window.open('file:///' + filePath.replace(/\\/g, '/'), '_blank');
                } else {
                    window.open(`${jobOrigin}/downloaded/${encodeURIComponent(filename)}`, '_blank');
                }
            }
        } else if (openFileBtn) {
            e.preventDefault();
            const filename = openFileBtn.getAttribute('data-file');
            openFileBtn.style.opacity = '0.5';
            const response = await Api.send("openDownloaded", "POST", { filename });
            openFileBtn.style.opacity = '1';
            let success = false;
            let filePath = null;
            if (response.ok) {
                try {
                    const data = await response.json();
                    if (data.status === 'opened file') success = true;
                    if (data.path) filePath = data.path;
                } catch (_) { }
            }
            if (!success && filePath) {
                window.open('file:///' + filePath.replace(/\\/g, '/'), '_blank');
            }
        } else if (openFolderBtn) {
            e.preventDefault();
            openFolderBtn.style.opacity = '0.5';
            const response = await Api.send("openDownloaded", "POST", { folder: true });
            openFolderBtn.style.opacity = '1';
            let success = false;
            let folderPath = null;
            if (response.ok) {
                try {
                    const data = await response.json();
                    if (data.status === 'opened folder') success = true;
                    if (data.path) folderPath = data.path;
                } catch (_) { }
            }
            if (!success && folderPath) {
                window.open('file:///' + folderPath.replace(/\\/g, '/'), '_blank');
            }
        }
    };
}
