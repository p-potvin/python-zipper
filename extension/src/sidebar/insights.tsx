/**
 * Insights tab.
 *
 * Reads `/api/zipper/insights`, which aggregates `zipper.history` — every file
 * actually taken, by day, by domain and by kind.
 *
 * This tab was a placeholder until now, and the reason it showed nothing was
 * not the endpoint: it was that nothing ever wrote history. `Api.recordGrabs`
 * existed with no caller, so the table stayed empty and the endpoint honestly
 * returned three empty arrays. The write side lives in background/grabbed.ts.
 *
 * A consequence worth stating in the UI rather than hiding: history only starts
 * from the first download made by a build that records it. An empty chart here
 * on day one is correct, not broken, and the empty state says so.
 */

import { signal } from '@preact/signals';
import { ext } from '../common/api';

interface Bucket {
  files: number;
  bytes: number;
}

interface DayRow extends Bucket { day: string }
interface DomainRow extends Bucket { domain: string }
interface KindRow extends Bucket { kind: string }

interface Insights {
  by_day: DayRow[];
  by_domain: DomainRow[];
  by_kind: KindRow[];
}

export const insights = signal<Insights | null>(null);
export const insightsError = signal('');
export const insightsLoading = signal(false);
export const days = signal(30);

export async function refreshInsights(): Promise<void> {
  insightsLoading.value = true;
  try {
    const res = await ext.runtime.sendMessage({ kind: 'insights:get', days: days.value });
    if (res?.ok) {
      insights.value = {
        by_day: res.data?.by_day || [],
        by_domain: res.data?.by_domain || [],
        by_kind: res.data?.by_kind || [],
      };
      insightsError.value = '';
    } else {
      insights.value = null;
      insightsError.value = res?.error || 'could not reach the API';
    }
  } catch (e: any) {
    insights.value = null;
    insightsError.value = String(e?.message || e);
  } finally {
    insightsLoading.value = false;
  }
}

function setDays(n: number): void {
  days.value = n;
  void refreshInsights();
}

// ---- formatting -------------------------------------------------------------

function fmtBytes(n?: number | null): string {
  if (!n) return '0 B';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "29 Aug" — the year is noise across a 90-day window. */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---- pieces -----------------------------------------------------------------

/**
 * Daily volume.
 *
 * Columns rather than an SVG chart: the sidebar is narrow and resizable, and a
 * flex row of percentage-height bars stays correct at any width without a
 * viewBox to fight. Scaled on bytes, because one 4GB video and four hundred
 * thumbnails are not the same day's work — but the tooltip carries both.
 */
function DayChart({ rows }: { rows: DayRow[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.bytes || 0), 1);
  return (
    <div class="chart">
      <div class="chart-bars">
        {rows.map((r) => (
          <div
            key={r.day}
            class="chart-col"
            title={`${fmtDay(r.day)} — ${r.files} file${r.files === 1 ? '' : 's'}, ${fmtBytes(r.bytes)}`}
          >
            {/* A day with files but almost no bytes still gets a visible stub,
                or a light day reads as a day with nothing at all. */}
            <div class="chart-fill" style={`height:${Math.max(3, ((r.bytes || 0) / max) * 100)}%`} />
          </div>
        ))}
      </div>
      <div class="chart-axis">
        <span>{fmtDay(rows[0].day)}</span>
        <span class="cell-spring" />
        <span>{fmtDay(rows[rows.length - 1].day)}</span>
      </div>
    </div>
  );
}

/** A ranked list with a proportional bar behind each row. */
function RankedList(
  { rows, label }: { rows: { key: string; files: number; bytes: number }[]; label: string },
) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.bytes || 0), 1);
  return (
    <ul class="ranked">
      {rows.map((r) => (
        <li key={r.key} class="rank" title={`${r.key} — ${r.files} ${label}, ${fmtBytes(r.bytes)}`}>
          <div class="rank-bar" style={`width:${Math.max(2, ((r.bytes || 0) / max) * 100)}%`} />
          <span class="rank-name">{r.key}</span>
          <span class="rank-files">{fmtCount(r.files)}</span>
          <span class="rank-bytes">{fmtBytes(r.bytes)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- view -------------------------------------------------------------------

export function InsightsTab() {
  const d = insights.value;
  const totalFiles = d ? d.by_day.reduce((n, r) => n + (r.files || 0), 0) : 0;
  const totalBytes = d ? d.by_day.reduce((n, r) => n + (r.bytes || 0), 0) : 0;
  const empty = !!d && !d.by_day.length && !d.by_domain.length && !d.by_kind.length;

  return (
    <div class="cap">
      <div class="cap-bar">
        <span class="selbar-n">last</span>
        {[7, 30, 90].map((n) => (
          <button
            key={n}
            class={`lnk${days.value === n ? ' lnk-on' : ''}`}
            onClick={() => setDays(n)}
          >
            {n}d
          </button>
        ))}
        <span class="cell-spring" />
        <button class="lnk" onClick={() => void refreshInsights()}>
          {insightsLoading.value ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {insightsError.value ? <div class="cap-err">{insightsError.value}</div> : null}

      {d && !empty ? (
        <>
          <div class="totals">
            <div class="total">
              <span class="total-n">{fmtCount(totalFiles)}</span>
              <span class="total-l">files</span>
            </div>
            <div class="total">
              <span class="total-n">{fmtBytes(totalBytes)}</span>
              <span class="total-l">downloaded</span>
            </div>
            <div class="total">
              <span class="total-n">{d.by_domain.length}</span>
              <span class="total-l">sites</span>
            </div>
          </div>

          <div class="sect">By day<span class="sect-note">scaled on size</span></div>
          <DayChart rows={d.by_day} />

          <div class="sect">Top sites<span class="sect-note">by size</span></div>
          <RankedList
            label="files"
            rows={d.by_domain.map((r) => ({ key: r.domain || 'unknown', files: r.files, bytes: r.bytes }))}
          />

          <div class="sect">By kind</div>
          <RankedList
            label="files"
            rows={d.by_kind.map((r) => ({ key: r.kind || 'unknown', files: r.files, bytes: r.bytes }))}
          />
        </>
      ) : null}

      {empty ? (
        <div class="empty">
          <h2>Nothing recorded yet</h2>
          <p>
            Every download is written to history from now on, and this fills in
            as you use it — by day, by site and by kind.
          </p>
          <p class="hint-note">
            Downloads made before this build was installed are not here: the
            extension marked them locally but never sent them, so there is
            nothing to backfill from.
          </p>
        </div>
      ) : null}

      {!d && !insightsError.value && !insightsLoading.value ? (
        <div class="empty">
          <h2>Insights</h2>
          <p>What you have taken, aggregated across every machine that grabs.</p>
        </div>
      ) : null}
    </div>
  );
}
