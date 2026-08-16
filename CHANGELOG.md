# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
