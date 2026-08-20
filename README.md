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
   `ZohoCRM.modules.leads.CREATE`, duration 10 minutes → **Create**.
4. Paste the one-time code into the admin page within a few minutes.

Leads arrive in Zoho with `Lead Source = Home Show`, standard fields mapped
(name/phone/email/city), and everything else — interests, timeline, notes,
consent — in the Description. `trigger: ["workflow"]` is set, so your CRM
assignment rules and notifications fire as if the lead was typed in by hand.

## Changing the form

Everything the visitor sees lives in [config/form.json](config/form.json) —
headline, thank-you text, fields, pill options, which Zoho field each input
maps to. Edit it and reload the iPad; no code changes.

## Tests

```bash
npm test
```
