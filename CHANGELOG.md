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
- **SVG File Classification (Issue #22)**: Removed `.svg` from `binaryExtensions` in `@vps-vault-sync/shared` so vector assets are classified as text format, avoiding base64 encoding overhead and enabling text-based merge capabilities.
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
