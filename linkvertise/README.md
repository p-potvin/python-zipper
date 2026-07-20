# Linkvertise OVH Mullvad Downloader

File-driven scaffold for resolving authorized Linkvertise-style links and preparing downloads on `vps-ovhcloud` through a separate `vw-linkvertise` Docker stack.

The default behavior is dry-run. Live batches require explicit `--yes-live`, `--max-links`, and `--rate` values, plus distinct allowed Mullvad profiles for Wave A and Wave B.

## Safety Model

- Real input lives in `linkvertise/input/links.txt` and is ignored by git.
- Runtime state, browser sessions, artifacts, logs, and downloads are ignored by git.
- Mullvad `.conf` files are secrets. The code lists filenames only for validation.
- Allowed profile filenames are limited to the 26-file alphabetic slice from `ca-mtr-wg-004.conf` through `ca-yyc-wg-202.conf`. In the current local source folder, `ca-mtr-wg-001.conf` through `ca-mtr-wg-003.conf` are outside that lower bound and are not installed.
- Flaresolverr is enabled in the OVH compose command with `FLARESOLVERR_CAP=1` by default.
- Linkvertise one-hour waits are persisted as idle sessions with `resume_at`, then resumed on the same WG profile.
- Download writes have a hard byte ceiling (`MAX_DOWNLOAD_BYTES`, default 50 GiB) and HTML/interstitial payloads are refused.

## Local Dry Runs

```powershell
$env:PYTHONPATH = "$PWD\linkvertise\src"
python -m linkvertise_downloader.cli --input linkvertise\input\links.example.txt --max-links 2 --dry-run
python -m linkvertise_downloader.cli profiles --source C:\Users\Administrator\Desktop\Backups\mullvad_wireguard_windows_ca_all --dry-run
```

## Scheduling

Each approved batch is split into two persisted waves.

- Wave A: first half of links, one WG profile, offsets from 0 to 9 minutes.
- Wave B: second half of links, different WG profile, offsets from 9 to 22 minutes.
- The recurring run window is deterministic per seed and falls between 50 and 70 minutes.

## OVH Runtime Shape

- App directory: `/opt/vw-linkvertise`
- Data directory: `/srv/vw-linkvertise`
- Input file: `/srv/vw-linkvertise/input/links.txt`
- Compose project: `vw-linkvertise`
- VPN service: `mullvad-rotation` (`qmcgaw/gluetun`) with container name `linkvertise-mullvad-rotation`
- Downloader service: `downloader`, with `network_mode: service:mullvad-rotation`
- Mullvad profile pool: `/opt/vw-linkvertise/mullvad-profiles/`
- Mullvad runtime env: `/opt/vw-linkvertise/.env.mullvad`, generated from one selected file in the profile pool

Do not deploy this into `/opt/vw-media-stack`; the media stack remains separate.

The gateway mirrors the media stack's Gluetun pattern and keeps `100.64.0.0/10` outside the tunnel so OVH tailnet services such as Flaresolverr remain reachable.

## Recurring Runs

Use `systemd/vw-linkvertise.service` and `systemd/vw-linkvertise.timer` on OVH after the manual dry-run path is proven. The timer uses `OnUnitActiveSec=50min` with `RandomizedDelaySec=20min`, giving a 50-70 minute window while preserving all session state under `/srv/vw-linkvertise/state/session_state.json`.

The host wrapper `bin/linkvertise-run-once` rotates the dedicated gateway to each configured profile, then runs the downloader with `--only-profile` so Wave A and Wave B keep their assigned egress config. Keep `MAX_LINKS=1` for the first live run.
