# Run Moodle Calendar independently of your computer

The selected host is **Railway**, starting with its Free/Trial allowance. The pilot is deployed at `https://moodle-calendar-production.up.railway.app`. [railway.json](../railway.json) configures one Docker service, readiness checks, no sleeping, and up to ten crash retries. The same health/restart settings were also applied directly to the hosted service. A local preview stops when your computer turns off; the cloud copy runs independently.

## Current pilot

Source: [hellomanzilco-cpu/moodlecal](https://github.com/hellomanzilco-cpu/moodlecal), branch `main`. The owner's repository is currently public; credentials, databases, reports, private setup links, and SSH keys are excluded. The deployment uses the verified local Git checkout uploaded with `railway up`, because Railway's GitHub integration has not yet been granted repository access. Pushing to GitHub alone does not deploy this service. To enable that later, connect the repository through Railway's GitHub App and use `railway service source connect --repo hellomanzilco-cpu/moodlecal --branch main --service moodle-calendar`.

The initial database was transferred privately and verified byte-for-byte before activation. It contains one connected student, seven courses, and 213 saved items; these counts describe the saved snapshot, not newly fetched Moodle data. Matching encrypted credentials were checked in the deployed container. The local bot remains stopped so only the hosted process consumes Telegram updates. Request the calendar URL again in Telegram to use the cloud origin.

Railway account inspection on 16 October 2026 confirmed an active trial with $5 remaining usage credit and 30 trial days remaining. No paid upgrade was enabled. The API calls this trial's underlying plan `HOBBY`, but reports `isTrialing=true` and `isUsageSubscriber=false`.

To deploy a later source change manually from this linked checkout, run `railway up --service moodle-calendar --detach`, then inspect deployment status and `/readyz`. Never pass `--no-gitignore` during an upload.

## Free plan limits

Railway's Free plan includes **$1 of resource usage per month**. A new trial provides a one-time $5 grant for up to 30 days, followed by the Free allowance. This is a usage budget, not a promise of unlimited 24/7 hosting. Monitor actual memory, CPU, network, and storage usage before relying on it. Keep the account on Free; do not enable a paid upgrade without the owner's agreement. Some limited trial accounts restrict outbound network access, which this bot needs for Telegram and Moodle.

Free/Trial supports a 0.5 GB persistent volume. The Free restart policy permits On Failure with at most ten retries. Telegram long polling keeps the bot busy even when students are not chatting, so serverless sleeping is unsuitable for this version. Exhausted credits or repeated crashes can interrupt service. Back up data before trial/credit expiry; Railway documents limited volume retention after expiry.

Sources checked 16 October 2026: [plans](https://docs.railway.com/pricing/plans), [trial](https://docs.railway.com/pricing/free-trial), [volumes](https://docs.railway.com/volumes/reference), [restart limits](https://docs.railway.com/deployments/restart-policy), [serverless](https://docs.railway.com/deployments/serverless).

## Deploy the prepared service

1. Create a **private** GitHub repository named `moodle-calendar`, and push the source. Keep `.env`, `data/`, backups, and private setup links out of Git. Connect Railway to that repository.
2. Create a Railway project/service from the repository. Railway reads `railway.json` and builds the existing Dockerfile. Use one service and one replica; no separate database service is needed.
3. Attach a persistent volume at **`/data`** before starting the app. Set these variables in Railway's protected environment settings:

   | Variable | Value |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | Existing bot token from local `.env` (`Bot_token` is its local alias). |
   | `ENCRYPTION_KEY` | Exact existing local key when migrating saved connections. |
   | `MOODLE_EVENT_SECRET` | Existing shared secret, if enabling the university event receiver. |
   | `TELEGRAM_MODE` | `polling` |
   | `HOST` | `0.0.0.0` |
   | `DATABASE_PATH` | `/data/moodle-calendar.sqlite` |
   | `RAILWAY_RUN_UID` | `0` |
   | `MOODLE_URL` | `https://moodle.uwed.uz` |
   | `DEFAULT_TIMEZONE` | `Asia/Tashkent` |

   `RAILWAY_RUN_UID=0` is Railway's documented workaround for root-owned volume mounts with a Docker image that otherwise runs as the `node` user. It applies to Railway runtime only. See [volume permissions](https://docs.railway.com/volumes/reference#caveats). Normal Docker/Compose operation remains unprivileged.

4. Generate a public Railway HTTPS domain. The app uses `RAILWAY_PUBLIC_DOMAIN` automatically for connection links and calendars. Do **not** copy the local `PUBLIC_URL=http://localhost:3000` or `HOST=127.0.0.1` to Railway. Set `PUBLIC_URL` only for a custom HTTPS domain. Railway supplies `PORT`; leave the start command unset so Docker runs `node src/main.ts` without needing an `.env` file.
5. Stop the local bot before starting the cloud copy: Telegram must have exactly one update consumer for this token. Polling here retrieves Telegram messages; it does not poll Moodle.
6. Deploy, verify `/healthz` and `/readyz`, then test **🔄 Auto update**, **📝 Assignments**, **📰 Recent updates**, and the calendar URL in your private chat. Restart Railway and verify the student connection survives. Your computer can then be turned off.

Volume-backed redeployments may briefly interrupt service. Disable automatic deployments during the pilot if you want to deploy changes deliberately. Check Railway's usage estimate and credit balance after deployment and during the first week.

The optional [Render Blueprint](../render.yaml) remains available for an explicitly chosen paid Render service. It is not the selected route. Render Free cannot supply this disk-backed always-on setup. [Free service limitations](https://render.com/docs/free).

## Move the current student connection

Run `npm run backup` to create a consistent SQLite backup under `data/backups/`. Stop the local bot before the final migration backup so no later update is left only on your computer. Transfer the database privately using Railway's volume file tools or SSH/SFTP to `/data/moodle-calendar.sqlite`. Preserve the exact matching `ENCRYPTION_KEY` in Railway. Keep the cloud bot stopped while replacing the database. Never commit the backup or build it into the image.

After restoring, confirm that the student connection and assignment views are present. Request the calendar URL again: the public origin has changed. If starting with an empty cloud database, connect each student's account again through the bot's browser flow.

Do not copy `.env` into the source repository or image. Hosting passes configuration through environment settings. Back up the encryption key separately from database files, with restricted access. Backup files contain private student metadata and encrypted credentials.

The container includes `scripts/backup.mjs`, so `npm run backup` can run inside the deployed service. A backup on the same volume alone does not protect against volume loss; download copies privately.

## Website changes and the Auto update button

**🔄 Auto update** reads the website when tapped and reports new documents, revised deadlines, submission changes, and visible grades. It compares against the last successful snapshot. **📰 Recent updates** stores up to 200 scoped changes from the last 30 days and displays the latest 30.

There is no periodic Moodle change scan. Hosting the bot 24/7 keeps it ready to respond and deliver deadline reminders from saved data. Automatic website-triggered updates still require UWED to configure the [Moodle bridge](MOODLE_EVENTS.md). Hosting alone does not add that university permission.
