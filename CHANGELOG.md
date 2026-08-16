# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] - 2026-08-16

### Fixed
- **Docker Multi-Stage Build**: Updated runner stage in Dockerfile to copy compiled artifacts (`dist/`) directly from the `builder` stage.
- **WebSocket Heartbeat & Keepalive**: Added `pong` and `ping` frame event listeners to ensure idle WebSocket connections remain active indefinitely across proxies without timing out.
- **Production Verification**: Validated live bidirectional sync on production Debian VPS alongside Cloudflare Tunnel and Nginx reverse proxy.
- **Authentication Secret Enforcement (Issue #2)**: Enforced required `SYNC_TOKEN` / `VAULT_SYNC_TOKEN` environment variable configuration on server startup in non-test environments, terminating with a fatal error instead of silently falling back to a hardcoded default token.
- **Header-Only Authentication (Issue #3)**: Restricted HTTP API token extraction strictly to the `Authorization: Bearer <token>` header, removing support for `?token=` query parameters to prevent credential leakage into reverse proxy logs and browser history.
- **Timing-Safe Auth & Rate Limiting (Issue #4)**: Implemented constant-time token comparison using `crypto.timingSafeEqual` to prevent timing side-channel leaks, and added per-IP authentication failure throttling (`AuthRateLimiter`) returning HTTP 429 and WebSocket rate-limit rejections after 5 failed attempts.
- **Restricted CORS Policy (Issue #5)**: Removed wildcard `Access-Control-Allow-Origin: *`, restricting CORS access exclusively to trusted localhost and Obsidian application origins (`app://obsidian.md`, `capacitor://localhost`).
- **Directory Traversal Protection (Issue #1)**: Implemented strict directory boundary containment validation in `VaultManager.getAbsolutePath()` and `getRelativePath()` ensuring all resolved file paths remain strictly contained within the vault directory root. Rejects attempts to traverse outside the vault via relative path escaping (`../`, `..\`), internal traversals, absolute paths, null-byte injections, or URL-encoded sequences across `readFile()`, `writeFile()`, `deleteFile()`, `getMetadata()`, and `ensureDirectory()`.
- **Rename Operation Traversal Safeguards (Issue #8)**: Added strict source and destination path containment checks to `VaultManager.renameFile()`, preventing arbitrary file moves to or from external host locations outside the vault directory.
- **WebSocket Payload Limits & Auth Timeout (Issue #9)**: Configured a 25MB `maxPayload` limit on `WebSocketServer` and implemented a 10-second authentication timeout that terminates unauthenticated connections to mitigate Slowloris resource exhaustion.
- **HTTP File Upload Byte Size Verification & Abort Safety (Issue #10)**: Updated `POST /api/file` to track exact buffer byte lengths rather than string characters and added an abort flag preventing file writing or double-response errors when requests exceed `maxFileSizeBytes`.
- **Server 3-Way Merge Base Retrieval (Issue #12)**: Implemented ancestor revision lookup via `ArchiveManager.getArchivedVersion()` matching `baseHash` when performing server-side 3-way line merges in `VaultManager.writeFile()`, enabling clean automated merges for non-conflicting concurrent edits.
- **Temporary Atomic Write Watcher Race (Issue #19)**: Updated temporary file naming format and added `**/*.tmp.*` to `DEFAULT_SYNC_OPTIONS.ignoredPatterns` to prevent `chokidar` from intercepting in-flight atomic write files and logging spurious ENOENT errors.
- **Health Check Information Leakage (Issue #20)**: Removed connected client count and protocol version disclosures from the unauthenticated `GET /health` endpoint.
- **Streaming Manifest Hash Calculation (Issue #21)**: Replaced full-file in-memory buffer reads in `VaultManager.buildManifest()` and `getMetadata()` with streaming SHA-256 digest computation (`crypto.createHash('sha256')`), eliminating memory spikes during vault reconciliation.
- **SVG File Classification (Issue #22)**: Removed `.svg` from `binaryExtensions` in `@vps-vault-sync/shared` so vector assets are classified as text format, avoiding base64 encoding overhead and enabling text-based merge capabilities.
- **Protocol Version Negotiation (Issue #23)**: Added handshake verification in `SyncServer` ensuring client protocol versions strictly match `PROTOCOL_VERSION` before allowing authentication.
- **Cryptographic Event ID Generation (Issue #24)**: Replaced non-cryptographic timestamp/random string IDs with `crypto.randomUUID()` across `SyncServer` and `VaultWatcher`.
- **Ignore Filter Comment Clarification (Issue #25)**: Updated misleading comment in `IgnoreFilter.isIgnored()` to accurately state that empty and root-only paths are ignored.

## [1.0.0] - 2026-08-16

### Added
- **Monorepo Structure**: Set up npm workspaces with `@vps-vault-sync/shared`, `@vps-vault-sync/server`, and `@vps-vault-sync/obsidian-plugin`.
- **Shared Sync Protocol**: Implemented typed WebSocket message contracts for client authentication, manifest diffing, file streaming, and live events.
- **3-Way Line Merge**: Intelligent line-based text merge for Markdown files using `diff-match-patch`, with automatic collision detection and `[Note].sync-conflict-[timestamp].md` generation.
- **Plain Filesystem VPS Storage**: Vault is saved as standard human-readable Markdown and asset files on the VPS disk.
- **Live Filesystem Watcher & Echo Cancellation**: Server detects local file changes on VPS disk using `chokidar` and broadcasts updates in real time to connected clients with write echo suppression.
- **Configuration & Plugin Sync**: Full bidirectional sync for `.obsidian/` (community plugins, themes, snippets, settings) with selective workspace layout toggle.
- **Version History & Trash Archive**: Automatic snapshot retention in `.sync-archive/` before overwriting or deleting files on the VPS.
- **Obsidian Plugin UI**: Status bar indicator (synced, syncing, disconnected, error), settings tab, and Activity Log Modal.
- **Docker & Reverse Proxy**: Multi-stage `Dockerfile`, `docker-compose.yml`, `docker-compose.caddy.yml` (auto-HTTPS), and templates for Nginx, Traefik, and Cloudflare Tunnels.
- **Automated Tests**: Unit and integration test suites covering merge algorithms, ignore parsing, hashing, and end-to-end WebSocket sync.
