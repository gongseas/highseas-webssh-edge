# Highseas WebSSH Edge

Highseas WebSSH Edge is a browser-based SSH/SFTP management console designed for Cloudflare Workers. It provides a FinalShell-inspired workflow with terminal sessions, server profiles, file editing, process and network monitoring, quick commands, and built-in account security.

This repository is the Cloudflare Edge edition. It is independent from the VPS/Node edition and does not include private server data, SSH keys, local databases, or deployment secrets.

## Features

- Real SSH terminal over WebSocket, powered by Cloudflare Workers TCP sockets and `ssh2`.
- Server profiles with password, PEM/OpenSSH key, and PuTTY PPK import support.
- SFTP file browser, upload/download, and text-file editing.
- Process monitor, CPU/memory/swap/disk metrics, and network connection view.
- Network panel with listening IP, port, connected IPs, geolocation, connection count, and per-IP traffic rate.
- Unified custom quick-command manager.
- Admin login, password hashing, session cookies, rate limiting, TOTP 2FA, and recovery codes.
- Encrypted storage for SSH passwords, private keys, passphrases, and TOTP secrets.
- Optional command history with sensitive-command filtering.
- Cloudflare D1 migrations and one-command setup script.

## Requirements

- Node.js 20 or newer.
- A Cloudflare account with Workers and D1 enabled.
- Wrangler login access on the machine used for deployment.

## Cloudflare Deployment

```bash
npm install
npx wrangler login
npm run setup:cloudflare
```

The setup script will:

1. Create a D1 database named `highseas-edge` when `wrangler.jsonc` still contains `REPLACE_WITH_D1_DATABASE_ID`.
2. Apply the D1 migrations.
3. Generate `highseas-master-key.txt`.
4. Store `MASTER_KEY` and `PASSWORD_PEPPER` as Worker secrets.
5. Build and deploy the Worker.

Open the `workers.dev` URL printed by Wrangler. On first visit, create the admin account. The admin password must be at least 12 characters.

## Updating

```bash
npm install
npm run db:remote
npm run worker:deploy
```

## Local Development

```bash
cp .dev.vars.example .dev.vars
# Replace MASTER_KEY with a base64 encoded 32-byte key.
npm run db:local
npm run build
npm run worker:dev
```

Generate a local key with:

```bash
openssl rand -base64 32
```

## Backup

Back up D1:

```bash
npx wrangler d1 export highseas-edge --remote --output highseas-edge-backup.sql
```

A complete backup must include both:

- `highseas-edge-backup.sql`
- The original `highseas-master-key.txt`

Do not lose `highseas-master-key.txt`. If it is lost, existing encrypted SSH credentials in D1 cannot be decrypted.

## Security Notes

- There is no default username or default password.
- `.dev.vars`, `.wrangler/`, `dist/`, `node_modules/`, and `highseas-master-key.txt` are ignored by git.
- Never commit real SSH keys, passwords, recovery codes, D1 exports, Worker secrets, or API tokens.
- Use Cloudflare account 2FA and narrow API-token permissions.
- For public deployments, consider putting Cloudflare Access in front of the Worker.
- Cloudflare Workers can connect only to public TCP endpoints. They cannot SSH into localhost, private LAN IPs, or Cloudflare-owned IP ranges.

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run worker:deploy
```

## License

MIT
