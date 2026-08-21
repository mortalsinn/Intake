# Ironwood Stair & Rail — Fall Home Show 2026 Intake

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
   `ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE,ZohoCRM.modules.attachments.CREATE`,
   duration 10 minutes → **Create**.
4. Paste the one-time code into the admin page within a few minutes.

Leads arrive with `Lead Source = Fall Home Show 2026`, standard fields mapped
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

## Photographs from the customer's phone

The thank-you screen shows a QR code. Scanning it opens a private upload page
on the visitor's **own phone, over their own mobile data** — so this path is
unaffected by the show's wifi. Photographs are downscaled in their browser
(2000px, JPEG) and attach to their lead in Zoho.

- The link is tied to one enquiry, unguessable, and expires after seven days,
  so a visitor can also upload later from home where the photographs are.
- An optional, unticked box asks whether Ironwood may use the photographs
  publicly. Whatever they choose is filed as its own note on the lead —
  including the exact wording shown — so whoever picks a photo for social
  media can see at a glance whether they are allowed to.
- Attachments are a third Zoho module: without
  `ZohoCRM.modules.attachments.CREATE` the photographs are held on the server
  and the admin page says so.
- A photograph waits if its lead has not reached Zoho yet, then attaches once
  it has — nothing is dropped for arriving early.

## Inspiration gallery

The form offers "Browse inspiration photos" — a full-screen picker (not a
popup: iOS Safari blocks those on a kiosk) showing work from
ironwoodstairs.com/gallery, filtered by the website's own tags. A visitor
picks up to three; they attach to their CRM lead as **Inspiration 1–3**.

Refresh the gallery whenever the website gains new work:

```bash
npm run gallery      # re-scrapes, re-downloads, rewrites config/gallery.json
```

It takes up to 18 photographs per filter so no chip lands on an empty grid,
caches ~500px thumbnails locally (fast, works offline), and leaves the
full-size image on the website — that is fetched only at the moment one is
attached to a lead. Edit `config/gallery.json` to curate by hand; the order
there is the order shown.

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

- `ADMIN_PIN` — **must be set.** Left unset, the server invents a random PIN
  at every boot, so the one in your logs stops working the moment it
  restarts. Six digits or more; this page shows customer contact details.
  Five wrong attempts locks that address out for fifteen minutes.
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- `ZOHO_DC` — `com` (or your datacenter)

`PORT` is set by Render automatically. Two operational notes:

- Running on a **Starter instance**: no spin-down, no 50-second cold start,
  and the disk survives restarts, so the enquiry log persists between
  deploys.
- **Still don't deploy during show hours.** A deploy restarts the process;
  anything mid-flight to Zoho is retried afterwards, but there is no reason
  to take the risk while a booth is running. Turn Auto-Deploy off.

## Tests

```bash
npm test
```
