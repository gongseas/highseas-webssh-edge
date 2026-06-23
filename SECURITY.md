# Security Policy

Do not publish real credentials in issues, pull requests, screenshots, or logs.

Sensitive local files are intentionally ignored by git:

- `.dev.vars`
- `.wrangler/`
- `dist/`
- `node_modules/`
- `highseas-master-key.txt`
- D1 SQL exports and other backups

If a GitHub token, Cloudflare token, SSH key, password, or `highseas-master-key.txt` is exposed, revoke or rotate it immediately.

For public deployments, use a strong admin password, enable TOTP, enable Cloudflare account 2FA, and consider adding Cloudflare Access in front of the Worker.
