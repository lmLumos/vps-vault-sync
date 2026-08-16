# Contributing to VPS Vault Sync

Thank you for your interest in contributing to **VPS Vault Sync**! We welcome contributions, bug reports, and feature requests to make Obsidian sync seamless and self-hostable.

---

## 🏗️ Repository Architecture

This project is organized as an npm workspaces monorepo:

- **`packages/shared`**: Shared TypeScript types, WebSocket protocol definitions, 3-way merge algorithms, hashing, and `.syncignore` filters.
- **`packages/server`**: Node.js/TypeScript VPS daemon, Chokidar file watcher, WebSocket server, and `.sync-archive` history manager.
- **`packages/plugin`**: The Obsidian plugin (TypeScript + esbuild).
- **`docker/`**: Ready-to-use Dockerfile, Docker Compose setups, and reverse proxy templates (Caddy, Nginx, Traefik, Cloudflare Tunnel).

---

## 🛠️ Development Setup

### Prerequisites

- **Node.js**: v18.0.0+ (v20+ recommended)
- **npm**: v9.0.0+
- **Docker**: (Optional, for running containerized server tests)

### Getting Started

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/lmLumos/vps-vault-sync.git
   cd vps-vault-sync
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build all packages:
   ```bash
   npm run build
   ```

4. Run tests:
   ```bash
   npm test
   ```

---

## 🧪 Testing Guidelines

- **Shared Package Tests**: Unit tests live in `packages/shared/src/*.test.ts`. Test all merge edge cases, ignore patterns, and protocol messages.
- **Server Integration Tests**: Integration tests live in `packages/server/src/*.test.ts`. Test server lifecycle, WebSocket connections, filesystem event detection, and archive retention.
- Ensure `npm test` and `npm run build` pass before submitting a Pull Request.

---

## 📝 Git & Commit Message Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` A new feature
- `fix:` A bug fix
- `docs:` Documentation only changes
- `refactor:` Code change that neither fixes a bug nor adds a feature
- `test:` Adding missing tests or correcting existing tests
- `chore:` Changes to the build process, dependencies, or auxiliary tools
- `ci:` Changes to CI configuration files and scripts

Example:
```bash
git commit -m "feat(plugin): add toggle for mobile workspace sync"
```

---

## 📬 Pull Request Process

1. Create a feature branch (`git checkout -b feat/my-new-feature`).
2. Make your changes and write/update tests.
3. Verify that `npm run build` and `npm test` pass.
4. Commit your changes following conventional commit guidelines.
5. Push to your fork and submit a Pull Request against `main`.
