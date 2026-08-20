# PLANO on Linux — build & development setup (Fedora KDE)

This documents the exact setup that produces a working `npm run dev` and `npm run dist:linux` on
this machine. It is the reference for anyone reproducing the Linux port.

## Why a btrfs build sandbox?

The git repo lives on an NTFS volume mounted via fuse (`/dev/sda2 fuseblk`) with `nosuid`. Electron's
`chrome-sandbox` helper needs the setuid bit, which `nosuid` makes impossible, so `npm run dev` and
packaged AppImages fail with "SUID sandbox helper binary is not configured correctly" when run from
the NTFS path. Native module builds and `node_modules` symlink/permission semantics are also fragile
on fuseblk.

The fix is a **btrfs working copy** at `~/plano-build` (`/home` is btrfs with normal POSIX
permissions). All source edits stay in the NTFS git checkout at
`/run/media/zakra/CORE/Tools/Plano` — that is the single source of truth. The btrfs copy is for
running and packaging only.

## Fedora packages

Install these with `dnf` (requires sudo):

```bash
sudo dnf install gcc-c++ make python3 fuse fuse-libs
```

- `gcc-c++`, `make`, `python3` — native module compilation (node-pty).
- `fuse`, `fuse-libs` — AppImage runtime (AppImage mounts via FUSE).

Verified installed versions on this machine:

| Package | Version |
|---|---|
| gcc-c++ | 16.1.1-2.fc44 |
| make | 4.4.1-12.fc44 |
| python3 | 3.14.7-1.fc44 |
| rpm-build | 6.0.2-1.fc44 |
| fuse | 2.9.9-25.fc44 |
| fuse-libs | 2.9.9-25.fc44 |

Node v22.23.2 and npm 10.9.8 are pre-installed on this host.

## One-time sandbox setup

```bash
mkdir -p ~/plano-build
```

## Sync the sandbox before each build

Run this from the git repo root to mirror source into the sandbox. It excludes everything that
should be regenerated on the btrfs side:

```bash
rsync -a --delete \
  --exclude node_modules \
  --exclude out \
  --exclude release \
  --exclude web-dist \
  /run/media/zakra/CORE/Tools/Plano/ \
  ~/plano-build/
```

Then in the sandbox:

```bash
cd ~/plano-build
npm install
npm run rebuild          # electron-rebuild node-pty against Electron 33's ABI
npm run model            # download the voice model into resources/models
npm run icons            # generate build/icons/<N>x<N>.png from build/icon.svg
```

## Verify the install

```bash
# Electron binary exists and runs
ls ~/plano-build/node_modules/electron/dist/electron

# node-pty rebuilt for Electron's ABI
~/plano-build/node_modules/.bin/electron-rebuild --version

# sherpa-onnx Linux binary installed
ls ~/plano-build/node_modules/sherpa-onnx-linux-x64/

# Voice model downloaded
ls ~/plano-build/resources/models/

# Icons generated
ls ~/plano-build/build/icons/
```

## Development

```bash
cd ~/plano-build
npm run dev
```

`npm run dev` (electron-vite dev) works from the btrfs path. If the SUID sandbox error appears on
a different machine, `--no-sandbox` is acceptable for dev only — never for a shipped build.

## Package the Linux build

```bash
cd ~/plano-build
npm run dist:linux
```

This runs `model && icons && build:web && electron-vite build && electron-builder --linux`, producing
an AppImage in `release/`.

The `build:web` step rebuilds `web-dist/` (the PLANO Mobile web app) before packaging so the
`extraResources` copy of `web-dist → resources/web` is fresh. Without it the packaged app ships stale
or absent web assets and PLANO Mobile is broken.

## Artifacts

After `npm run dist:linux`, `release/` contains:

- `PLANO-<version>-x64.AppImage` — portable, auto-update-capable (electron-updater supports
  AppImage only on Linux).
- `PLANO-<version>-x64.AppImage.blockmap` — delta-update blockmap.
- `latest-linux.yml` — electron-updater feed metadata.
There is no rpm. The `rpm` target was removed from the `linux` block because it cannot build here:
electron-builder 25 ships fpm 1.9.3 (2017), and Fedora 44's `rpmbuild` 6.0.2 rejects the spec it
generates — `Process failed: rpmbuild failed (exit code 1)`. The AppImage packs fine, but the rpm
failure aborts the whole run before `latest-linux.yml` is written, so the target has to be off.
Re-adding it needs a working fpm: `USE_SYSTEM_FPM=1` with a modern fpm on PATH, or packaging in a
container with an older rpm.

## Publishing (do not run unless releasing)

```bash
# From the git repo (publishes existing release/ artifacts, does not rebuild)
node scripts/publish-release.mjs --platform linux --skip-build

# Or build then publish in one step
npm run release:linux
```

Requires the GitHub CLI (`gh`) installed and authenticated. See `scripts/publish-release.mjs` for
the full sanity-check flow (version consistency between `latest-linux.yml` and `package.json`).
