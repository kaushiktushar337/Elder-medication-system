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

To check the Supabase connection before starting the API, put the Session pooler URL in the ignored `.env` file and run `npm run db:check`. The check reports whether the migration table exists. Starting the API applies pending setup.

The default `SUPABASE_TLS_MODE=verify-full` verifies the database server certificate. For a temporary demo, `SUPABASE_TLS_MODE=require` still encrypts the connection but skips server identity verification. Remove the override once the CA certificate is available.

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
| `BREVO_SMS_SENDER` | Optional. Set only after verifying transactional SMS on your account and destination. |

Render Free sleeps after 15 minutes of inactivity. Supabase preserves profile and schedule data while Render is asleep, but the reminder loop resumes only after the service wakes. Open the site before presenting and keep one care-circle session open during the live walkthrough. [Render free-tier limits](https://render.com/docs/free)

## Rehearse the demo

1. Open the Vercel URL. Select **Create my patient account** and use the setup key, a team-controlled email and a password of at least 12 characters. Sign out and sign in with that email and password to confirm the existing patient workspace returns.
2. In **People & access**, add a contact with **Create a one-time patient invite key** checked. Copy the key from the dialog or select **Send the invitation by email**. In a separate browser session, sign in to a care-team account. Open the emailed link or choose **Link a patient with an invite key**. Review the invitation, select a relationship, and accept or decline. Emailed invites require the recipient's email and expire after seven days. On the patient side, **People who can see your schedule** lists accepted relationships.
3. In **Schedule**, add a synthetic daily medication. Add an appointment within the next 24 hours to check real Brevo delivery. Verify the email in the inbox and check **Reminder activity** on the owner’s view. “Accepted by Brevo” means the provider accepted the send request.
4. On the patient’s **Today** screen, enable alarm sound. Set a synthetic medication to the next minute in IST. The patient's open page shows the alert and repeats the alarm for up to 30 seconds. Use **Silence alarm** to stop the sound. After five minutes without confirmation, the patient card turns red and the scheduler emails the linked care team. Use **Please check in** to rehearse the handoff immediately.
5. In the caregiver session, tap **I’ll call**. Show the caregiver’s name in both sessions. Record **Mark taken** as the owner and show that the history retains both actions.
6. Verify revocation from the owner’s view. A revoked patient disappears from the caregiver’s patient list. Existing users can select **Switch from a personal sign-in code** and set up an email and password for the same account. Previously issued caregiver invite keys remain eligible for one redemption.

For an elder-initiated handoff, tap **Please check in** in Today. The request appears in the caregiver’s Today view, and the next scheduler run alerts opted-in contacts if it is still waiting for a caller. After claiming it, the caller or profile owner can mark the check-in complete. The same completion action is available on claimed dose follow-ups and leaves the dose’s confirmation status separate.

On **Today**, use **Read today aloud** for a spoken overview of the selected patient's doses and next appointment. It uses an on-device English voice when the browser provides one. Open **History** for dose records and the printable seven-day summary. **Appointments** contains pending requests and scheduled appointments. Doctors can search generic medication names in **Schedule** or type a name as prescribed.

Care-team accounts open a patient overview. Red cards indicate overdue unconfirmed doses, and yellow cards indicate pending appointment requests. Select a card to open that patient's workspace. Patients can request an appointment with a linked doctor. The scheduler emails the assigned doctor, who can accept and enter a time in **Appointments**. That time will appear on the patient's dashboard. The medication form supports a start date, optional end date, an interval in days, and explicit skipped dates. **Next seven days** previews the resulting schedule.

In **Refills**, record the number of doses physically on hand and choose a threshold and reminder recipient. Confirmed doses decrease that count. The forecast uses the active schedule and skips excluded dates. When there is an upcoming shortage and the count reaches the threshold, the scheduler sends one email per recorded count. Update the count after each refill.

In **Appointments**, patients can add questions for the assigned doctor and propose another time for an upcoming visit. The original time remains scheduled until the doctor accepts the proposal. The doctor can post a short summary after the scheduled time. Visit questions and summaries are visible to the patient and assigned doctor. **Schedule** shows who last saved a medication schedule and when it takes effect.

**Read today aloud** uses a local English voice when one is available. Otherwise, it plays bundled English clips that describe due, overdue, or upcoming doses and whether an appointment is coming up. Exact medication names and times remain visible on Today. The fallback never sends care details to a speech service.

Under **People & access → Handoff escalation**, the patient can choose two linked people and a delay of 5 to 120 minutes. The primary gets the first email for a check-in or an overdue dose. The backup gets an email only if the follow-up is still unclaimed when the delay passes. From **Today**, the team can see which linked recipients were emailed and who claimed the follow-up.

To send one live reminder for a synthetic missed dose, configure `BREVO_API_KEY` and `BREVO_FROM_EMAIL` in the ignored `.env` file. Optionally set `BREVO_TEST_EMAIL` to your test inbox. Run `node --env-file=.env scripts/smoke-brevo-reminder.mjs --send`. The script uses an isolated database and otherwise sends the test back to the sender address.

The test suite exercises the API with a test sender. To run it against an embedded PostgreSQL runtime, install `@electric-sql/pglite` temporarily with `npm install --no-save --package-lock=false @electric-sql/pglite` and set `TEST_POSTGRES=1` before running `npm test`.
