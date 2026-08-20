# Ironwood Stair & Rail — Home Show Intake

An iPad kiosk that captures visitor info at a home show and feeds it into
Zoho CRM as Leads. Built for home-show reality: the wifi can drop, Zoho can
be down, the server can restart — **no lead is ever lost**.

## How leads survive

```
iPad (localStorage queue)  →  server (data/leads.json)  →  Zoho CRM (Leads)
```

1. Every submission is saved on the iPad first, then synced to the server.
   A retry loop flushes the queue whenever the network allows; a pill in the
   corner tells staff what's still waiting.
2. The server writes each lead to disk before answering. That write is the
   receipt — Zoho comes later, in a background pusher with backoff.
3. Zoho doesn't even need to be connected during the show. Leads queue on
   disk and sync the moment it's connected. CSV export works regardless.

Duplicates can't happen: each submission carries a client-generated id and
both the server and Zoho pushes dedupe on it.

## Running it

```bash
npm install
npm start          # prints kiosk URL, admin URL, and the admin PIN
```

- Open the printed URL on the iPad (same wifi as the server). Use Safari's
  **Add to Home Screen** for a full-screen kiosk; the service worker keeps
  the form loading even if the wifi drops.
- `/admin.html` is the staff page: live counts, Zoho status, retry, CSV.
- Set `ADMIN_PIN` in `.env` to stop the PIN rotating every boot.

## Connecting Zoho CRM (once, ~5 minutes)

This app needs its own tiny Zoho connection — the AscendOS token can't be
reused because Zoho freezes scopes when the code is generated, and it has no
Leads scope.

1. Log in to [api-console.zoho.com](https://api-console.zoho.com) as the CRM
   admin → **Add Client** → **Self Client**.
2. In `/admin.html` → *Connect Zoho CRM*, paste the Client ID and Secret.
3. In the console's **Generate Code** tab, use scope
   `ZohoCRM.modules.leads.CREATE,ZohoCRM.modules.notes.CREATE`,
   duration 10 minutes → **Create**.
4. Paste the one-time code into the admin page within a few minutes.

Leads arrive with `Lead Source = Home Show`, standard fields mapped
(name/phone/email/city), and a Description reading *"Captured at the
&lt;show&gt; — &lt;when&gt;. Full details in Notes."* Everything from the booth —
assessment, contact, what they want, the conversation, consent — is filed
as a formatted **Note** on the lead, which is where the follow-up crew
reads and replies. `trigger: ["workflow"]` is set, so CRM assignment rules
and notifications fire as if the lead was typed in by hand.

**Notes need their own scope.** Zoho freezes scopes when the code is
generated, so a token made with only `leads.CREATE` cannot write notes. The
app detects this, says so on the admin badge, and falls back to putting the
full detail in the Description — nothing is ever dropped — but reconnecting
with both scopes is what gets you the tidy Notes.

## Changing the form

Everything the visitor sees lives in [config/form.json](config/form.json) —
headline, thank-you text, fields, pill options, which Zoho field each input
maps to. Edit it and reload the iPad; no code changes.

## Deploying to Render

Create a **Web Service** (not a Static Site — the Node server is what holds
the lead log, the admin API, and the Zoho secrets), or use "New → Blueprint"
which reads [render.yaml](render.yaml). Settings if doing it by hand:

| Setting | Value |
|---|---|
| Repository / branch | `mortalsinn/Intake` / `main` |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/form` |

Environment variables (Render wipes the disk on every deploy, so the Zoho
connection must come from env — copy the values out of `data/zoho.json` on
the machine where you connected):

- `ADMIN_PIN` — strong, this admin page is on the public internet
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- `ZOHO_DC` — `com` (or your datacenter)

`PORT` is set by Render automatically. Two operational notes:

- **Free tier sleeps** after ~15 idle minutes and takes ~50s to wake. The
  kiosk pings every 4 minutes while open, which keeps it awake through the
  show day — but open the iPad a few minutes before doors. A $7 Starter
  instance removes the issue entirely.
- **Don't deploy during show hours.** A deploy restarts the instance and
  wipes any leads that haven't pushed to Zoho yet (normally a seconds-wide
  window; synced leads are already safe in the CRM). The CSV export reads
  the same disk, so download it before any redeploy.

## Tests

```bash
npm test
```
