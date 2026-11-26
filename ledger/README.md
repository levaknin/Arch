# Partner Ledger

Records partner deposits and shop expenses (RM) for three users:

| User  | Can do                                              |
|-------|-----------------------------------------------------|
| Eli   | Add, edit and delete all entries                    |
| Moshe | Add entries; edit and delete only entries he added  |
| Igor  | View only                                           |

Permissions are enforced by the server. Data is stored in SQLite on a Fly.io volume.
Every create, edit and delete is also written to an `audit` table (who, when, before/after).

## Deploy to Fly.io (one-time setup)

1. Create a Fly.io account at https://fly.io and add a payment card (required by Fly even for small apps).
2. Install flyctl on your computer and run `fly auth login`, then `fly tokens create org -o personal`.
   Copy the token it prints.
3. In GitHub: repository **Settings → Secrets and variables → Actions → New repository secret**. Add:
   - `FLY_API_TOKEN`: the token from step 2
   - `ELI_PASSWORD`, `MOSHE_PASSWORD`, `IGOR_PASSWORD`: one password each, at least 12 characters
4. Merge this code into `main`. The **Deploy Partner Ledger to Fly.io** workflow runs the tests, creates the
   app and its volume on first run, and deploys. You can also start it from the Actions tab (**Run workflow**).
5. The app is at `https://partner-ledger-c6910c.fly.dev`. If that name is taken, change `app` in `fly.toml`.

To change a password: update the GitHub secret and re-run the workflow. That user's existing sign-ins stop working.

## Backups

Fly takes daily snapshots of the volume (kept 5 days by default). For a copy you control:

```
fly ssh console -a partner-ledger-c6910c -C "node -e \"new (require('node:sqlite').DatabaseSync)('/data/ledger.db').exec(\\\"VACUUM INTO '/data/backup.db'\\\")\""
fly ssh sftp get /data/backup.db ledger-backup.db -a partner-ledger-c6910c
fly ssh console -a partner-ledger-c6910c -C "rm /data/backup.db"
```

(`VACUUM INTO` makes a consistent copy even while the app is running.)

## Run locally

```
cd ledger
ELI_PASSWORD=eli-password-123 MOSHE_PASSWORD=moshe-password-123 IGOR_PASSWORD=igor-password-123 \
SESSION_SECRET=$(openssl rand -hex 32) INSECURE_COOKIES=1 npm start
# open http://localhost:8080
npm test
```

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`; no npm dependencies).

## Limits

- Runs on a single machine because SQLite lives on one volume. Don't scale to more machines.
- The machine stops when idle and starts on the next visit (a second or two of delay).
