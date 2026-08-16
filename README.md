# ⚡ VPS Live Vault Sync for Obsidian

A high-performance, real-time, bi-directional synchronization system between **Obsidian** (Desktop & Mobile) and a self-hosted **VPS server**.

Your notes, attachments, plugins, themes, and configuration files live on your VPS as a **normal, human-readable directory**. Edit files on your VPS with vim, VS Code Remote, or scripts, and watch them update live in Obsidian across all your devices.

---

## ✨ Features

- **⚡ Real-Time Bidirectional Sync**: Instant live syncing over WebSockets with automatic reconnection and exponential backoff.
- **📁 Plain Files on VPS**: Your vault is stored directly on your VPS disk as standard Markdown and assets. No opaque proprietary database or vendor lock-in.
- **🖥️ Direct VPS Edits**: Edit files directly on the server disk (via SSH, scripts, Git pulls) — file changes are detected via `chokidar` and immediately broadcast to all connected devices.
- **🧩 Full `.obsidian/` Sync**: Synchronize community plugins, themes, CSS snippets, hotkeys, and plugin settings.
- **📱 Device-Specific Workspace Toggle**: Option to exclude `workspace.json` so mobile and desktop devices can maintain separate panel/tab layouts while keeping themes and plugins in sync.
- **🔀 3-Way Line-Based Merge**: Concurrently edited notes automatically merge non-overlapping lines. On direct collisions, creates `[Note].sync-conflict-[date].md` backups so no data is ever lost.
- **📦 Version History & Safe Trash**: Edits and deletions are safely archived in `.sync-archive/` on your VPS with configurable retention days.
- **🔒 Echo Suppression**: Prevents network loops when files are written remotely.
- **📴 Offline Queue**: Changes made while disconnected are queued locally and synchronized automatically upon reconnection.
- **🐳 Docker Ready**: 1-minute containerized deployment with optional automated Let's Encrypt SSL via Caddy.

---

## 🏗️ Architecture Overview

```mermaid
flowchart LR
    subgraph Clients["Obsidian Clients (Desktop / iOS / Android)"]
        ClientA["Obsidian Client A<br/>(Obsidian Plugin)"]
        ClientB["Obsidian Client B<br/>(Obsidian Plugin)"]
    end

    subgraph VPS["VPS Server (Docker)"]
        ReverseProxy["Reverse Proxy / SSL<br/>(Caddy / Nginx / Tunnel)"]
        SyncServer["VPS Sync Daemon<br/>(Node.js / TypeScript)"]
        LocalFS["Local Vault Folder<br/>(/data/vault)"]
        Archive["Version History & Trash<br/>(.sync-archive)"]
    end

    ClientA <-->|WSS + HTTPS API<br/>(Token Auth)| ReverseProxy
    ClientB <-->|WSS + HTTPS API<br/>(Token Auth)| ReverseProxy
    ReverseProxy <--> SyncServer
    SyncServer <-->|Chokidar Watcher & Echo Suppression| LocalFS
    SyncServer -->|Backup / Retention| Archive
```

---

## 🚀 Quick Start (VPS Server Setup)

### Option 1: Docker Compose with Automatic HTTPS (Recommended)

1. Clone this repository on your VPS:
   ```bash
   git clone https://github.com/your-repo/vps-vault-sync.git
   cd vps-vault-sync/docker
   ```

2. Edit `docker-compose.caddy.yml`:
   ```yaml
   services:
     sync-server:
       environment:
         - SYNC_TOKEN=your-strong-secret-token-here
       volumes:
         # Path to your vault folder on the VPS host:
         - /home/ubuntu/my-vault:/data/vault

     caddy:
       environment:
         - DOMAIN=sync.yourdomain.com
         - EMAIL=admin@yourdomain.com
   ```

3. Launch the container stack:
   ```bash
   docker compose -f docker-compose.caddy.yml up -d
   ```
   Caddy will automatically obtain a free Let's Encrypt SSL certificate and proxy traffic to the sync server.

---

### Option 2: Standard Docker Compose (Existing Reverse Proxy)

If you already use Nginx, Traefik, or Cloudflare Tunnels:

```yaml
version: '3.8'
services:
  sync-server:
    build:
      context: ..
      dockerfile: packages/server/Dockerfile
    container_name: vps-vault-sync
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - SYNC_TOKEN=your-strong-secret-token-here
      - VAULT_PATH=/data/vault
      - ARCHIVE_RETENTION_DAYS=30
    volumes:
      - /path/to/your/vps/vault:/data/vault
```

Run:
```bash
docker compose up -d
```

---

## 📲 Obsidian Plugin Installation

### Manual Installation (Desktop & Mobile)

1. Build or download the plugin release files:
   - `main.js`
   - `manifest.json`
   - `styles.css`

2. Copy these 3 files into your Obsidian vault plugin folder:
   `<YourVault>/.obsidian/plugins/vps-vault-sync/`

3. In Obsidian, go to **Settings > Community plugins**:
   - Reload installed plugins.
   - Toggle **VPS Live Vault Sync** ON.

4. Open the plugin settings (**Settings > VPS Live Vault Sync**):
   - **Server URL**: `wss://sync.yourdomain.com` (or `ws://YOUR_VPS_IP:3000`)
   - **Secret API Token**: The `SYNC_TOKEN` configured in your server `.env` or `docker-compose.yml`.
   - **Device Name**: Give your device a name (e.g. *MacBook Pro*, *iPhone*).
   - Click **Test Connection** & verify the green success notice.
   - Click **Sync Now** to perform initial reconciliation!

---

## ⚙️ Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SYNC_TOKEN` | *Required* | Shared secret API token for authentication |
| `VAULT_PATH` | `/data/vault` | Path to the directory where files are stored on VPS |
| `PORT` | `3000` | HTTP & WebSocket listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `ARCHIVE_RETENTION_DAYS` | `30` | Number of days to keep overwritten / deleted note backups |
| `MAX_FILE_SIZE_MB` | `100` | Maximum single attachment upload size |
| `DEBOUNCE_MS` | `400` | Delay before broadcasting VPS disk edits |
| `SYNC_OBSIDIAN_CONFIG` | `true` | Bidirectionally sync `.obsidian` plugins, themes, and settings |
| `SYNC_WORKSPACE` | `false` | Sync `workspace.json` tab/layout state across devices |

---

## 📂 Custom `.syncignore`

Place a `.syncignore` file in the root of your vault to exclude specific folders or files from syncing:

```gitignore
# Exclude private folders
Private/**
Secrets/*.md

# Exclude temporary or large build artifacts
node_modules/
dist/
*.log
```

---

## 🛠️ Development & Building

This repository is structured as a TypeScript monorepo using npm workspaces:

```bash
# 1. Install all dependencies across packages
npm install

# 2. Build shared library, server, and Obsidian plugin
npm run build

# 3. Run unit and integration tests
npm test
```

---

## 📜 License

MIT License. Contributions and PRs welcome!