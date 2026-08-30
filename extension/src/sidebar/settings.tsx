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

const baseUrl = signal('');
const keyInput = signal('');
const hasKey = signal(false);
const keyHint = signal('');
const status = signal<{ kind: 'idle' | 'ok' | 'err' | 'busy'; text: string }>({
  kind: 'idle', text: '',
});

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
  return (
    <div class="cap">
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
