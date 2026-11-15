# CareCircle

CareCircle is a hackathon demo for older adults and their care circles. It combines a daily medication alarm, appointment reminders, individual passcode access, and an “I’ll call” handoff for unconfirmed doses.

## Run locally

Install Node.js 24, then run:

```sh
npm ci
npm test
npm run dev
```

Open [localhost:3000](http://localhost:3000). Local development uses SQLite unless you set `DATABASE_URL`. Copy [.env.example](.env.example) to `.env` to configure live email or connect to Supabase. Keep credentials in environment variables.

## Deploy on Vercel, Render Free, and Supabase

1. Push this project to your team's Git repository. Create a Supabase project and copy its **Connect → Session pooler** PostgreSQL connection string on port 5432. Replace the password placeholder with the database password, URL-encoding special characters. The Render service creates and migrates a private `carecircle` database schema on startup. If Node reports a TLS certificate error, set `SUPABASE_DB_CA` on Render to the Supabase-provided certificate PEM. [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
2. Import the repo into Vercel as an **Other** project with no build command and output directory `public`. Take note of its production HTTPS URL. The first deployment serves the frontend. Its API starts working after the Render service is up and the rewrite target matches. [Vercel external rewrites](https://vercel.com/docs/routing/rewrites)
3. In Render, create a Blueprint from the same repo with [render.yaml](render.yaml) and select **Free**. Set the variables below. Wait for the deploy and open the Render service's `/healthz` URL to verify database connectivity. [Render Blueprints](https://render.com/docs/infrastructure-as-code)
4. Replace the placeholder origin in [vercel.json](vercel.json) with the exact Render service URL, keeping the `/api/:path*` suffix, and redeploy Vercel. Use the Vercel production URL for the demo so browser requests and session cookies share one origin.

| Render variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase Session pooler connection string |
| `APP_URL` | Vercel production URL, for example `https://carecircle-demo.vercel.app` |
| `PROFILE_SETUP_KEY` | Random secret shared privately with the team for creating demo profiles |
| `BREVO_API_KEY` | Brevo API key |
| `BREVO_FROM_EMAIL` | Verified Brevo sender email |
| `DEMO_MINUTES` | `1` in the Blueprint. Clear to hide the demo control. |
| `BREVO_SMS_SENDER` | Optional. Set only after verifying transactional SMS on your account and destination. |

Render Free sleeps after 15 minutes of inactivity. Supabase preserves profile and schedule data while Render is asleep, but the reminder loop resumes only after the service wakes. Open the site before presenting and keep one care-circle session open during the live walkthrough. [Render free-tier limits](https://render.com/docs/free)

## Rehearse the demo

1. Open the Vercel URL. Create a synthetic profile using the setup key and a team-controlled inbox. Save the owner passcode locally.
2. In **Care Circle**, add a caregiver with an email and alert permission. Copy their individual passcode. Sign in with it from a private browser window or a second device.
3. In **Schedule**, add a synthetic daily medication. Add an appointment within the next 24 hours to check real Brevo delivery. Verify the email in the inbox and check **Reminder activity** on the owner’s view. “Accepted by Brevo” means the provider accepted the send request.
4. On the owner’s **Today** screen, enable sound and schedule a demo dose. The open page displays the alert and sounds in about 20 seconds. Leave the dose unconfirmed for one minute. The next server tick sends the check-in email, so allow up to another minute.
5. In the caregiver session, tap **I’ll call**. Show the caregiver’s name in both sessions. Record **Mark taken** as the owner and show that the history retains both actions.
6. Verify revocation from the owner’s view. For judge access, create a fresh synthetic profile and share only the intended passcodes. Create the profile shortly before submission so it is available for the walkthrough.

The test suite exercises the API with a test sender. To run it against an embedded PostgreSQL runtime, install `@electric-sql/pglite` temporarily with `npm install --no-save --package-lock=false @electric-sql/pglite` and set `TEST_POSTGRES=1` before running `npm test`.
