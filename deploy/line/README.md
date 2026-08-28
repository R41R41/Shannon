# LINE deployment templates

These are **not installed** and do not authorize live startup. Follow `docs/line-deployment.md`.

- Replace `@COMMIT@` with the exact 40-character dev-verified release commit before installing the systemd unit. Keep the existing Shannon Bot unit unchanged.
- Review the nginx fragment within the real TLS server block, preserve the previous configuration, run `nginx -t`, then reload. Never replace the whole nginx config with this fragment.
- `radar.disabled.example.json` is an inactive placeholder. No live sources/location/schedule/consent have been assumed.
- Credentials and a reviewed hash-bound `launch-permit.json` belong only in `~/.config/shannon-line-prod/` (700/600). Do not put them here.
- Dependencies for the standalone bundle are fixed by the generated `backend/dist-line/package-lock.json`; preserve and verify that lock with the release artifact. Do not copy all dev dependencies into production.
- Stop/rollback only the new LINE service and its exact nginx location; never automatically retry unknown sends or roll back to a writer that does not understand LINE-2 ledger fields.
