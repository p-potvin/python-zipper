/**
 * Settings tab.
 *
 * Currently the VaultWares API connection, which is the thing that has to be
 * right before anything else works. The key is write-only from the UI's point
 * of view: the background returns whether one is set and a short prefix, never
 * the value. There is no reason for the panel to be able to read it back, and
 * plenty of reasons not to.
 */

import { signal } from '@preact/signals';
import { ext } from '../common/api';
import {
  DEFAULT_SETTINGS, loadSettings, saveSettings, type ZipperSettings,
} from '../common/settings';

const baseUrl = signal('');
const keyInput = signal('');
const hasKey = signal(false);
const keyHint = signal('');
const status = signal<{ kind: 'idle' | 'ok' | 'err' | 'busy'; text: string }>({
  kind: 'idle', text: '',
});

/**
 * The page-facing options.
 *
 * These live here rather than on the Capture tab on purpose. Highlighting and
 * the in-page button used to be per-scan controls, which meant they reset every
 * time you looked for something — and a control you have to re-enable on every
 * use is one you stop using. They describe how the extension behaves while you
 * browse, so they belong with the other things that are true until changed.
 */
export const opts = signal<ZipperSettings>({ ...DEFAULT_SETTINGS });

export async function loadOptions(): Promise<void> {
  opts.value = await loadSettings();
}

async function setOpt<K extends keyof ZipperSettings>(key: K, value: ZipperSettings[K]): Promise<void> {
  // Optimistic, then authoritative: the switch should move under the finger,
  // but `saveSettings` clamps and normalises, so the stored value wins.
  opts.value = { ...opts.value, [key]: value };
  opts.value = await saveSettings({ [key]: value } as Partial<ZipperSettings>);
}

function Toggle(
  { label, hint, on, onChange }:
  { label: string; hint: string; on: boolean; onChange: (v: boolean) => void },
) {
  return (
    <label class="opt">
      <input type="checkbox" checked={on}
             onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span class="opt-text">
        <span class="opt-label">{label}</span>
        <span class="opt-hint">{hint}</span>
      </span>
    </label>
  );
}

export async function loadApiConfig(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'api:config:get' });
    if (res?.ok) {
      baseUrl.value = res.baseUrl || '';
      hasKey.value = !!res.hasKey;
      keyHint.value = res.keyHint || '';
    }
  } catch { /* background unavailable */ }
}

async function save(): Promise<void> {
  status.value = { kind: 'busy', text: 'Saving…' };
  try {
    await ext.runtime.sendMessage({
      kind: 'api:config:set',
      baseUrl: baseUrl.value.trim(),
      // Empty means "leave the stored key alone" — otherwise saving a URL
      // change would silently wipe the key.
      ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
    });
    keyInput.value = '';
    await loadApiConfig();
    await test();
  } catch (e: any) {
    status.value = { kind: 'err', text: String(e?.message || e) };
  }
}

async function test(): Promise<void> {
  status.value = { kind: 'busy', text: 'Testing…' };
  try {
    const res = await ext.runtime.sendMessage({ kind: 'api:health' });
    status.value = res?.ok
      ? { kind: 'ok', text: `Connected — ${res.data?.jobs ?? 0} job(s) on record` }
      : { kind: 'err', text: res?.error || 'Could not reach the API' };
  } catch (e: any) {
    status.value = { kind: 'err', text: String(e?.message || e) };
  }
}

export function SettingsTab() {
  const s = status.value;
  const o = opts.value;
  return (
    <div class="cap">
      <div class="sect">On the page</div>

      <Toggle
        label="Outline media"
        hint="Dashed border around every grabbable file, always — not just after a scan."
        on={o.highlight}
        onChange={(v) => void setOpt('highlight', v)} />

      <Toggle
        label="Hover download button"
        hint="A button in the corner of whatever media you point at."
        on={o.injectButton}
        onChange={(v) => void setOpt('injectButton', v)} />

      {o.injectButton ? (
        <label class="field">
          <span>Smallest element that gets a button</span>
          <input class="inp inp-sm" type="number" min="0" max="200" step="1"
                 value={String(o.minButtonPx)}
                 onChange={(e) => void setOpt('minButtonPx', Number((e.currentTarget as HTMLInputElement).value))} />
          <span class="opt-hint">
            Below this the button would cover the element and swallow the click
            that opens it, so it is refused outright. 22px is about the floor.
          </span>
        </label>
      ) : null}

      <Toggle
        label="Scan on interaction"
        hint="Re-scan what changes right after you click, scroll or type — never on the page's own churn."
        on={o.liveScan}
        onChange={(v) => void setOpt('liveScan', v)} />

      <div class="sect">Downloads</div>

      <Toggle
        label="Zip more than one file"
        hint="Two or more files download as a single archive instead of separate entries."
        on={o.zipMultiple}
        onChange={(v) => void setOpt('zipMultiple', v)} />

      <div class="sect">VaultWares API</div>

      <label class="field">
        <span>Base URL</span>
        <input class="inp" type="url" placeholder="https://api.vaultwares.ca"
               value={baseUrl.value}
               onInput={(e) => { baseUrl.value = (e.currentTarget as HTMLInputElement).value; }} />
      </label>

      <label class="field">
        <span>API key {hasKey.value ? `· set (${keyHint.value})` : '· not set'}</span>
        <input class="inp" type="password" autocomplete="off"
               placeholder={hasKey.value ? 'Leave blank to keep the current key' : 'vwk_…'}
               value={keyInput.value}
               onInput={(e) => { keyInput.value = (e.currentTarget as HTMLInputElement).value; }} />
      </label>

      <div class="actions">
        <button class="btn" onClick={() => void save()}>Save</button>
        <button class="btn btn-alt" onClick={() => void test()}>Test</button>
        <span />
      </div>

      {s.kind !== 'idle' ? (
        <div class={s.kind === 'err' ? 'cap-err' : 'deep'}>
          {s.kind === 'ok' ? <span class="led led-online">ok</span> : null}
          {s.kind === 'busy' ? <span class="led led-relay">…</span> : null}
          <span>{s.text}</span>
        </div>
      ) : null}

      <p class="hint-note">
        Keys are accepted only from a trusted IP, so a 403 usually means this
        machine isn't on the tailnet rather than a bad key. Provider credentials
        (debrid, Usenet) stay on the server and are never stored here.
      </p>
    </div>
  );
}
