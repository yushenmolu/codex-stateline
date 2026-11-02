# Portable Windows Distribution

## User Contract

- Download only `Codex-Stateline.exe` from GitHub Releases and double-click it.
- Windows 10/11 x64, Windows PowerShell 5.1 and the system .NET Framework/WPF are supported. No Node.js, npm, .NET SDK, administrator access or manual extraction is required.
- The first launch extracts a private runtime cache under `%LOCALAPPDATA%\codex-companion\portable\<payload-hash>`. Later launches verify and reuse it. The download directory remains a single-file directory, including when its path contains spaces or non-ASCII characters.
- Existing Codex data, login and relay settings remain external. This companion does not include an account, credentials or model access. Generation benchmarks still require the user's existing Codex CLI; browser animation previews use the system Microsoft Edge.
- Close means hide to tray. Use the tray's Exit command before updating or removing a running EXE. Repeated launches reveal the existing widget, using the existing single-instance and server-ownership protocol.

The executable is currently unsigned. Windows SmartScreen may show an unknown-publisher warning. Verify the repository and optional SHA-256 checksum; do not disable operating-system protection. A paid/trusted signing certificate is not included in this project.

## Implementation

`scripts/build-portable.ps1` compiles a small x64 GUI executable with the Windows .NET Framework C# compiler. Its embedded archive contains an explicit list of app entry scripts, native sources, `src/`, package metadata, the official Node.js executable and its complete license notices. It does not include repository history, logs, screenshots, Codex configuration, auth files, real conversation fixtures or benchmark results.

The official Node.js archive version and SHA-256 are pinned in `scripts/portable/node-runtime.json`. The build verifies the full downloaded archive before taking `node.exe` and `LICENSE` from it. No npm packaging dependency, third-party EXE wrapper or installer is used.

The bootstrapper verifies the embedded archive and every extracted file, serializes cache preparation per user/version, rejects path traversal/reparse points and publishes the completed cache by a same-parent directory rename. A modified cache is retained as `damaged-*` and replaced with a verified copy; it is not executed or recursively deleted. Cache preparation errors stop startup rather than weakening checks. No automatic background updater or startup registration is installed.

The existing launcher prefers its adjacent `runtime/node.exe` and otherwise retains source-checkout Node discovery. The portable bootstrapper clears only `NODE_OPTIONS` and `NODE_PATH` for its child; Codex and relay environment settings continue to inherit normally. The existing nonce, listener PID/start-time checks and owned-server cleanup remain in control.

## Build And Check

From a Windows x64 source checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/portable-package.selftest.ps1
```

Equivalent developer shortcuts are `npm run build:portable` and `npm run test:portable`. The build itself does not require a system Node installation: it downloads and verifies the pinned official runtime. An offline build can supply the exact same official ZIP using `-NodeArchive C:\downloads\node-v26.1.0-win-x64.zip`; checksum verification is mandatory in either mode.

Outputs are `dist/Codex-Stateline.exe` and optional `dist/SHA256SUMS.txt`. Build inputs/intermediates remain under ignored `build/`, while self-test evidence remains under ignored `.test-tmp/`. Neither folder is committed or uploaded to a release.

The actual EXE exposes two explicit diagnostic modes:

```powershell
Codex-Stateline.exe --verify C:\existing-folder\verify.json
Codex-Stateline.exe --self-test C:\existing-folder\runtime.json
```

The package check copies only that EXE into a fresh directory with spaces and non-ASCII characters, removes Node from its child PATH, and tests cold extraction, warm reuse, same-size cache corruption recovery, reparse rejection and unsafe archive names. It then uses the real packaged Node server, static assets, WPF fixture window, screenshot and owned-service shutdown. No model request is submitted. The self-test requires free port 4173 and fails without stopping a pre-existing listener.

## GitHub Release

`.github/workflows/portable-release.yml` validates pushes to `main` and pushed version tags such as `v1.1.0`. It builds on Windows and runs the real packaged-runtime check with no system Node on PATH. Only a successful tag run can publish, and its tag must match `package.json`: it then creates the GitHub Release and attaches the single EXE plus its checksum. A `main` push never publishes. Test failures also emit escaped GitHub annotations so the failure cause remains visible without access to private job logs. Release permission is scoped to the release job; the checkout action is pinned to a commit and checkout credentials are not persisted. The repository token is supplied only to the publication step.

The permanent latest-download link is:

<https://github.com/yushenmolu/codex-stateline/releases/latest/download/Codex-Stateline.exe>

Tagging/pushing/publishing is a separate externally visible action and must be explicitly authorized. A normal source push does not publish a release.

## Update, Rollback And Removal

Quit the tray app before replacing its EXE. Each payload has its own verified cache, so a previous release EXE can be used for rollback without overwriting current app assets or benchmark history. A running older instance is revealed rather than silently replaced.

To remove the portable app, quit it, delete the downloaded EXE, then optionally remove only `%LOCALAPPDATA%\codex-companion\portable\`. Other files in `%LOCALAPPDATA%\codex-companion\`, especially `benchmark.json`, belong to user history and are not an install cache. Do not delete `.codex`, Codex credentials or unrelated user data. Source-launcher shortcuts/autostart entries, if installed separately in the past, are not changed by this portable version.
