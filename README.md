# CareCircle

CareCircle is a hackathon demo for older adults and their care circles. It combines a daily medication alarm, appointment reminders, patient-approved access, and an “I’ll call” handoff for unconfirmed doses.

## Project structure

```text
public/
  index.html           Browser entry point
  js/
    app.js             Dashboard state, navigation, and interactions
    appointments.js    Appointment views and role-specific actions
    medication-photo.js Image resizing before upload
    view-helpers.js    Shared date formatting and escaped markup
    language.js        Language, text-size, and theme preferences
    i18n/hi.js         Hindi interface translations
  css/styles.css       Responsive layouts and themes
  voice/               Bundled audio fallback
src/
  server.mjs           Node HTTP server and reminder timer
  http/router.ts       Request validation, access checks, and API routing
  auth/                Password hashing and session handling
  features/            Dashboard data, medications, care circles, follow-ups, and reminders
  db/                  SQLite/PostgreSQL adapters and migration loader
  core.ts              Shared time constants and small API/query helpers
migrations/            Ordered SQL schema changes
scripts/               Database maintenance and deployment smoke checks
test/
  unit/                Password and refill calculation tests
  integration/         HTTP, API workflows, permissions, and email delivery
```

Vercel serves `public/` and forwards same-origin API requests to Render. The Render process starts at [src/server.mjs](src/server.mjs). Database adapters load the ordered SQL files in [migrations/](migrations/) during startup.

Authentication helpers live in `src/auth/`. Feature modules use the shared helpers in `src/core.ts` and receive a database adapter through their environment argument. The HTTP router checks patient access before invoking appointment handlers. Reminder deliveries are keyed by event, reminder type, recipient, and channel to prevent duplicate sends on concurrent runs.

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

Vercel serves `public/` and forwards `/api/*` to Render. Render runs the API and scheduler, queries Supabase, and sends email through Brevo. The browser uses the Vercel origin for both the frontend and API, which keeps the session cookie on that host.

1. **Supabase.** Open **Connect → Session pooler**, copy the PostgreSQL URL on port 5432, and substitute the URL-encoded database password. If needed, download the CA from **Database Settings → SSL Configuration** for verified TLS. The API creates and migrates the private `carecircle` schema on startup. [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
2. **Vercel.** Import the branch that contains these deployment files. Keep the repository root and use the **Other** framework preset. [vercel.ts](vercel.ts) serves `public/` directly. Deploy once to get the stable production HTTPS URL. Without the Render origin, this first deploy serves the frontend while the API is being provisioned. [Vercel programmatic configuration](https://vercel.com/docs/project-configuration/vercel-ts)
3. **Render.** Select **New → Blueprint**, connect the same repository and branch, and apply [render.yaml](render.yaml). It uses a Free Node.js web service, `npm ci && npm test` to build, `npm start` to run, and `/healthz` for health checks. Fill in the Render variables below. For an existing Render service, use its **Environment** page to set them. Save the Render HTTPS URL after it deploys. [Render Blueprints](https://render.com/docs/infrastructure-as-code)
4. **Connect the frontend.** In Vercel **Settings → Environment Variables**, set `RENDER_API_ORIGIN` for **Production** to the exact Render HTTPS origin, for example `https://elder-carecircle-api.onrender.com`. Use the origin without `/api` or any other path. Redeploy Vercel so the build-time rewrite picks up the variable. Use the Vercel production URL for signed-in testing. Preview deployments need their own matching backend and allowed origin. [Vercel external rewrites](https://vercel.com/docs/routing/rewrites)

| Where | Variable | Value |
| --- | --- | --- |
| Vercel | `RENDER_API_ORIGIN` | Render service HTTPS origin |
| Render | `APP_URL` | Vercel production HTTPS origin, for example `https://carecircle-demo.vercel.app` |
| Render | `DATABASE_URL` | Supabase Session pooler connection string |
| Render | `BREVO_API_KEY` | API key for notification delivery |
| Render | `BREVO_FROM_EMAIL` | Actual verified Brevo sender email. A display name will cause delivery failures. |
| Render | `SUPABASE_DB_CA` | Optional PEM certificate contents when the default trust store cannot verify Supabase |
| Render | `NODE_EXTRA_CA_CERTS` | Alternative to `SUPABASE_DB_CA`. Point to an uploaded CA file such as `/etc/secrets/supabase-ca.crt`. |
| Render | `SUPABASE_TLS_MODE` | Optional. Defaults to `verify-full`. Use `require` only for a temporary demo if you accept skipping certificate verification. |
| Render | `BREVO_SMS_SENDER` | Optional. Enable only after verifying SMS availability and sender approval. |

Keep Supabase and Brevo secrets in Render. Use the dashboard environment variables even if the same settings are present in your local `.env`. Render supplies `PORT` and `RENDER_EXTERNAL_URL` automatically. [Render environment variables](https://render.com/docs/environment-variables)

### Verify the hosted app

Open the Render URL with `/healthz` and the Vercel URL with `/api/health`. Both should return `{"ok":true}`. Then run the hosted smoke check with your actual Vercel origin:

```sh
node scripts/smoke-deployment.mjs https://carecircle-demo.vercel.app
```

Set `CARECIRCLE_TEST_EMAIL` and `CARECIRCLE_TEST_PASSWORD` in your shell to include the optional sign-in, cookie, and sign-out checks with an existing synthetic account. If Render is cold, allow it to wake and rerun the check. A Vercel `404` at `/api/health` usually means the rewrite variable is missing or the project needs a redeploy. A sign-in response of `403` with `Origin denied` means Render's `APP_URL` and the browser's origin differ.

If the Render build passes and startup fails with `SELF_SIGNED_CERT_IN_CHAIN`, add the Supabase CA certificate in Render's **Environment → Secret Files** as `supabase-ca.crt`. Its contents should start with `-----BEGIN CERTIFICATE-----`; a `.crt` or `.cer` extension can still contain PEM. Set `NODE_EXTRA_CA_CERTS=/etc/secrets/supabase-ca.crt` and `SUPABASE_TLS_MODE=verify-full`, then redeploy. Clear any stale `SUPABASE_DB_CA` value when using this file-based option. For a temporary demo without the CA, set `SUPABASE_TLS_MODE=require` on Render and redeploy. That fallback encrypts the connection with certificate verification disabled. [Render Secret Files](https://render.com/docs/configure-environment-variables#secret-files) · [Supabase TLS setup](https://supabase.com/docs/guides/platform/ssl-enforcement)

Render Free sleeps after 15 minutes of inactivity. Supabase preserves profile and schedule data while Render is asleep, but the reminder loop resumes only after the service wakes. Open the site before presenting and keep one care-circle session open during the live walkthrough. [Render free-tier limits](https://render.com/docs/free)

## Rehearse the demo

1. Open the Vercel URL. Select **Patient signup** and use a team-controlled email and a password of at least 12 characters. Sign out and sign in with that email and password to confirm the existing patient workspace returns. To sign into another account at the same time, open a new browser tab and enter the Vercel URL.
2. Create the recipient's account through **Care-team signup**. In the patient workspace, open **People & access**. To invite by account email, enter that email and select **Send an in-app invitation to this email address**. The recipient sees it in **Invitations**, chooses their relationship, and accepts or declines. To share a code instead, enter a name and create a one-time invite code. It expires after 24 hours. The patient can review accepted names and relationships under **People who can see your schedule**.
3. In **Schedule**, add a synthetic daily medication. Request an appointment in **Appointments** to check real Brevo delivery. Verify the email in the inbox and check **Reminder activity** on the owner’s view. **Email sent** means the provider accepted the send request.
4. On the patient’s **Today** screen, enable alarm sound. Set a synthetic medication to the next minute in IST. The patient's open page shows the alert and repeats the alarm for up to 30 seconds. Use **Silence alarm** to stop the sound. After five minutes without confirmation, the patient card turns red and the scheduler emails the linked care team. Use **Please check in** to rehearse the handoff immediately.
5. In the caregiver session, tap **I’ll call**. Show the caregiver’s name in both sessions. Record **Mark taken** as the owner and show that the history retains both actions.
6. Verify revocation from the owner’s view. A revoked patient disappears from the caregiver’s patient list. Existing users can select **Switch from a personal sign-in code** and set up an email and password for the same account. Previously issued caregiver invite keys remain eligible for one redemption.

For an elder-initiated handoff, tap **Please check in** in Today. The request appears in the caregiver’s Today view, and the next scheduler run alerts opted-in contacts if it is still waiting for a caller. After claiming it, the caller or profile owner can mark the check-in complete. The same completion action is available on claimed dose follow-ups and leaves the dose’s confirmation status separate.

On **Today**, use **Read today aloud** for a spoken overview of the selected patient's doses and next appointment. It uses an on-device English voice when the browser provides one. Open **History** for dose records and the printable seven-day summary. **Appointments** contains pending requests and scheduled appointments. Doctors can search generic medication names in **Schedule** or type a name as prescribed.

Care-team accounts open a patient overview. Red cards indicate overdue unconfirmed doses, and yellow cards indicate pending appointment requests. Select a card to open that patient's workspace. Use **Back to patient list** to return to the overview. The doctor overview also shows upcoming appointments and scheduling requests. Patients and linked family or caregivers can request an appointment with a doctor already linked to the patient. The scheduler emails the assigned doctor, who can accept and enter a time in **Appointments**. That time appears on the patient's dashboard.

In **Refills**, record the number of doses physically on hand and choose a threshold and reminder recipient. Confirmed doses decrease that count. The forecast uses the active schedule and skips excluded dates. When there is an upcoming shortage and the count reaches the threshold, the scheduler sends one email per recorded count. Update the count after each refill.

In **Appointments**, patients can add questions for the assigned doctor or request a change for an upcoming visit. **Today** offers the same action when an appointment is coming up that day. Enter a reason and the next time you are available in IST. The original time remains scheduled until the doctor accepts. Visit questions, change reasons and summaries are visible to the patient and assigned doctor. **Schedule** shows who last saved a medication schedule and when it takes effect.

Select **हिन्दी**, **Larger text**, or **Dark mode** in the header to change the display on this browser. Hindi applies to interface text such as appointment status and validation messages. Use **Schedule → Medication photo** to upload a picture of the medication packaging or label. CareCircle resizes it in the browser and shows it beside the next dose on Today. The photo is a visual reference for the saved schedule.

**Read today aloud** uses a local English voice when one is available. Otherwise, it plays bundled English clips that describe due, overdue, or upcoming doses and whether an appointment is coming up. Exact medication names and times remain visible on Today. The fallback never sends care details to a speech service.

Under **People & access → Handoff escalation**, the patient can choose two linked people and a delay of 5 to 120 minutes. The primary gets the first email for a check-in or an overdue dose. The backup gets an email only if the follow-up is still unclaimed when the delay passes. From **Today**, the team can see which linked recipients were emailed and who claimed the follow-up.

To send one live reminder for a synthetic missed dose, configure `BREVO_API_KEY` and `BREVO_FROM_EMAIL` in the ignored `.env` file. Optionally set `BREVO_TEST_EMAIL` to your test inbox. Run `node --env-file=.env scripts/smoke-brevo-reminder.mjs --send`. The script uses an isolated database and otherwise sends the test back to the sender address.

## Verify changes locally

Run `npm test` with Node.js 24. The suite uses synthetic accounts and mocked notification delivery. It checks cross-patient access, single-use invitations, appointment changes, alternating and skipped doses, refill forecasts, concurrent reminder deduplication, and handoff escalation. It also checks that generating a three-day dose window takes one SQL statement.

`npm run test:coverage` reports backend line, branch, and function coverage. The HTTP test starts an isolated server on an available local port with an in-memory database and checks security headers, request-size limits, session logout, and 24 concurrent dashboard reads. It requires permission to bind and connect to localhost. Provider tests mock Brevo success, rate limiting, rejection, server failures, and interrupted connections. Browser behavior and live provider delivery need separate checks.

To run the API integration tests on embedded PostgreSQL, install `@electric-sql/pglite` temporarily with `npm install --no-save --package-lock=false @electric-sql/pglite` and set `TEST_POSTGRES=1` before running `npm test`.
