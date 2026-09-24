// ========================================================
// Filename: server.js
// Description: Home-show intake server.
//
// One process, three jobs:
//   1. Serve the iPad kiosk form and the admin page.
//   2. Receive leads and write them to disk IMMEDIATELY —
//      the disk write is the receipt; Zoho comes later.
//   3. Push pending leads to Zoho CRM in the background,
//      retrying until they land. Zoho can be down (or not
//      even connected yet) for the entire show and every
//      lead still syncs when it comes up.
// ========================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const { createStore } = require('./lib/store');
const { safeEqual, rateLimiter, lockout } = require('./lib/guard');
const { validateLead } = require('./lib/validate');
const zoho = require('./lib/zoho');
const mail = require('./lib/mail');

const PORT = Number(process.env.PORT) || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR);

// Admin PIN. Never a shipped default — this page shows customer names,
// telephone numbers and email addresses.
//
// An unset PIN generates a random one, which is fine on a laptop and awful
// on a hosted server: it changes on every restart, so the value in the logs
// and the value that works drift apart and nobody can get in. Hosted
// deployments must set it, and are told so loudly.
const PIN_WAS_GENERATED = !process.env.ADMIN_PIN;
const ADMIN_PIN = process.env.ADMIN_PIN || String(crypto.randomInt(100000, 999999));
const PIN_IS_WEAK = ADMIN_PIN.length < 6;

// Guards. Windows are short; this is abuse control, not a firewall.
const pinLock = lockout({ maxAttempts: 5, lockMs: 15 * 60 * 1000 });
// Generous on purpose. Every iPad on the venue's wifi shares one public
// address, and after a wifi outage a device flushes its whole backlog at
// once — a tight limit would throttle the booth's own recovery. A scripted
// flood is orders of magnitude above this.
const limitLeads = rateLimiter({ windowMs: 60 * 1000, max: 60 });
const limitPhotos = rateLimiter({ windowMs: 10 * 60 * 1000, max: 40 });
const limitAdmin = rateLimiter({ windowMs: 60 * 1000, max: 60 });

// Behind Render's proxy the real client is in x-forwarded-for; without this
// every visitor looks like the same address and one busy iPad would rate
// limit the whole booth.
const clientIp = (req) =>
    (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

// Two forms share one pipeline: the enquiry form and the contest entry.
// Same durability — device copy, journal, disk, CSV — with entries tagged so
// a prize draw never lands in the middle of the show's sales leads.
// Two brands share one iPad: Ironwood's booth and Code Compass by Ribit.
// A brand is not a mode switch — each has its own spec, its own Lead_Source
// and its own owner, so a Ribit demo request can never be filed as an
// Ironwood railing enquiry. 'kind' already threads through the store, the
// CSV export and the Zoho push, so a brand is one more kind.
const CONFIGS = { enquiry: 'form.json', contest: 'contest.json', ribit: 'ribit-form.json' };
// Where each kind is delivered. Ironwood enquiries go to the CRM. Code
// Compass demo requests never enter the CRM — they are emailed to our own
// inbox (lib/mail.js). A prize draw entrant has asked for nothing, and
// goes nowhere but the disk and its CSV.
const CRM_KINDS = new Set(['enquiry']);
const MAIL_KINDS = new Set(['ribit']);
const isKind = (k) => Object.prototype.hasOwnProperty.call(CONFIGS, k);
const formConfig = (kind = 'enquiry') =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'config', CONFIGS[isKind(kind) ? kind : 'enquiry']), 'utf8'));

const app = express();
// Scoped to /api on purpose. A global parser runs BEFORE the route-specific
// one, so a global 100kb cap silently rejected every photograph upload with
// 413 no matter what limit the upload route asked for. Form posts stay
// small and capped; the photo route sets its own limit below.
// Modest, boring headers. No framing, no MIME sniffing, no referrer leakage
// of upload tokens to third parties.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

app.use('/api', express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- kiosk ----------

/** The brand chooser the kiosk opens on. Absent file = single-brand kiosk. */
app.get('/api/brands', (req, res) => {
    try {
        res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'brands.json'), 'utf8')));
    } catch {
        res.status(404).json({ error: 'No brands configured.' });
    }
});

app.get('/api/form', (req, res) => {
    try {
        res.json(formConfig(req.query.kind));
    } catch (err) {
        res.status(500).json({ error: `config/form.json is invalid: ${err.message}` });
    }
});

/**
 * Booth health, for the kiosk's status pill. No PIN and no personal data —
 * counts and connection state only.
 *
 * Exists because the iPad could only ever report its OWN queue, so it said
 * "all synced" the moment the server accepted a lead — true, and dangerously
 * misleading if the server cannot reach Zoho. Staff must be able to see that
 * from the booth, not discover it days later.
 */
app.get('/api/status', (req, res) => {
    const z = store.getZoho();
    res.json({
        demoMode: store.isDemo(),
        zohoConnected: !!z,
        // A refused write outranks the optimistic scope guess: proof beats
        // assumption, and env-var connections can only be proven this way.
        zohoNotes: z ? (zoho.canWriteNotes(z) && !noteScopeProblem) : false,
        zohoPhotos: z ? (zoho.canWriteAttachments(z) && !attachmentScopeProblem) : false,
        counts: store.counts(),
        photos: store.photoCounts(),
        mail: {
            configured: mail.canSend() && !store.isDemo(),
            to: mail.mailConfig().to,
            ...store.mailCounts(MAIL_KINDS),
        },
    });
});

/** The inspiration gallery the kiosk shows. Absent file = feature off. */
app.get('/api/gallery', (req, res) => {
    try {
        res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'gallery.json'), 'utf8')));
    } catch {
        res.status(404).json({ error: 'No gallery configured.' });
    }
});

app.post('/api/leads', (req, res) => {
    // The kiosk submits one enquiry a minute at most; anything above this is
    // somebody with the URL, not a visitor.
    if (!limitLeads(clientIp(req)).allowed) {
        return res.status(429).json({ error: 'Too many submissions. Please wait a moment.' });
    }
    const kind = isKind(req.body?.kind) ? req.body.kind : 'enquiry';
    let cfg;
    try {
        cfg = formConfig(kind);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    const errors = validateLead(req.body, cfg);
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

    const { added, uploadToken } = store.addLead({
        id: req.body.id,
        submittedAt: req.body.submittedAt,
        fields: req.body.fields,
        kind,
    });
    // A kind that never goes to the CRM is marked so at capture, not when
    // the Zoho pusher next runs — the pusher does not run at all while Zoho
    // is disconnected, and until then these leads were counted as "awaiting
    // transfer to Zoho", a transfer that was never going to happen.
    if (added && !CRM_KINDS.has(kind)) store.updateLead(req.body.id, { status: 'local' });
    // The disk write above is the durable receipt — respond now, push later.
    // Retries from the iPad land here again with the same id and dedupe.
    // uploadUrl comes back so the kiosk can show the customer a QR code.
    // No upload link for a brand without photographs: the kiosk draws the QR
    // only when a link comes back, so a demo request never asks a software
    // buyer for pictures of their project.
    const uploadUrl = cfg.photos === false ? null : uploadPath(req, uploadToken);
    res.json({ ok: true, duplicate: !added, uploadUrl });
    if (added) { setImmediate(pushPending); setImmediate(pushMail); }
});

/**
 * The staff priority tap, which lands a moment after the lead itself.
 *
 * No PIN: the id is a client-generated UUID nobody else holds, the window is
 * seconds wide, and a PIN prompt between "Submit" and the next visitor would
 * never survive a real booth.
 */
app.post('/api/leads/:id/priority', (req, res) => {
    const priority = String(req.body?.priority || '').slice(0, 60);
    if (!priority) return res.status(400).json({ error: 'No priority given.' });
    const lead = store.setPriority(req.params.id, priority);
    if (!lead) return res.status(404).json({ error: 'No such enquiry.' });
    // Priority is in; nothing left to wait for.
    store.releaseHold(req.params.id);
    res.json({ ok: true });
    setImmediate(pushPending);
    setImmediate(pushMail);
});

/**
 * The kiosk has finished with this lead without a priority — Skip, or a
 * screen timed out with nobody there. Stop holding it and send it now.
 * Same trust model as the priority tap: an id only the kiosk holds.
 */
app.post('/api/leads/:id/release', (req, res) => {
    const lead = store.releaseHold(req.params.id);
    if (!lead) return res.status(404).json({ error: 'No such enquiry.' });
    res.json({ ok: true });
    setImmediate(pushPending);
    setImmediate(pushMail);
});

// The address a customer's phone must reach. Behind Render's proxy the
// original scheme arrives in x-forwarded-proto; without it a phone would be
// handed an http:// link to an https-only host.
function uploadPath(req, token) {
    if (!token) return null;
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
    return `${proto}://${req.get('host')}/u/${token}`;
}

/** QR image for an upload link, drawn server-side so the kiosk needs no library. */
app.get('/api/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//.test(url)) return res.status(400).send('bad url');
    try {
        const svg = await QRCode.toString(url, {
            type: 'svg', margin: 1, errorCorrectionLevel: 'M',
            color: { dark: '#1d1d1d', light: '#ffffff' },
        });
        res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ---------- customer photo upload (their phone, their data) ----------

app.get('/u/:token', (req, res) => {
    const lead = store.leadByUploadToken(req.params.token);
    if (!lead) return res.status(404).sendFile(path.join(__dirname, 'public', 'upload-expired.html'));
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

/** What the upload page needs to know about itself. */
app.get('/u/:token/info', (req, res) => {
    const lead = store.leadByUploadToken(req.params.token);
    if (!lead) return res.status(404).json({ error: 'This link has expired.' });
    let cfg;
    try { cfg = formConfig(lead.kind); } catch { cfg = { company: {} }; }
    res.json({
        firstName: lead.fields.firstName || '',
        company: cfg.company?.name || 'Ironwood Stair & Rail',
        already: (lead.photos || []).length,
    });
});

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

app.post('/u/:token/photos', express.json({ limit: '24mb' }), (req, res) => {
    if (!limitPhotos(req.params.token).allowed) {
        return res.status(429).json({ error: 'Too many uploads for this enquiry. Please wait a few minutes.' });
    }
    const lead = store.leadByUploadToken(req.params.token);
    if (!lead) return res.status(404).json({ error: 'This link has expired.' });

    const items = Array.isArray(req.body?.photos) ? req.body.photos : [];
    if (!items.length) return res.status(400).json({ error: 'No photographs received.' });
    if ((lead.photos || []).length + items.length > 12) {
        return res.status(400).json({ error: 'That is more photographs than we can accept for one enquiry.' });
    }

    // Publishing permission is per upload, recorded with the exact wording
    // shown, and only ever set — a later batch sent without the box ticked
    // must not silently revoke a permission already given.
    const mayShare = req.body?.mayShare === true;

    let saved = 0;
    for (const item of items.slice(0, 12)) {
        const m = /^data:(image\/(?:jpeg|png|webp|heic));base64,(.+)$/i.exec(String(item.dataUrl || ''));
        if (!m) continue;
        const buffer = Buffer.from(m[2], 'base64');
        if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) continue;
        store.addPhoto(lead.id, { buffer, filename: item.name, mimeType: m[1] });
        saved++;
    }
    if (!saved) return res.status(400).json({ error: 'Those files could not be read as photographs.' });

    store.recordPhotoPermission(lead.id, {
        mayShare,
        statement: String(req.body?.shareStatement || '').slice(0, 600),
        count: saved,
    });

    res.json({ ok: true, saved });
    setImmediate(pushPhotos);
});

// ---------- admin ----------

function requirePin(req, res, next) {
    const ip = clientIp(req);
    if (!limitAdmin(ip).allowed) {
        return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
    }
    const locked = pinLock.blocked(ip);
    if (locked) {
        return res.status(429).json({
            error: `Too many incorrect PINs. Locked for ${Math.ceil(locked / 60)} more minute(s).`,
        });
    }
    if (safeEqual(req.get('x-admin-pin'), ADMIN_PIN)) {
        pinLock.succeed(ip);
        return next();
    }
    const lockedFor = pinLock.fail(ip);
    console.warn(`[admin] wrong PIN from ${ip}${lockedFor ? ` — locked out for ${Math.ceil(lockedFor / 60)}m` : ''}`);
    res.status(401).json({
        error: lockedFor
            ? `Too many incorrect PINs. Locked for ${Math.ceil(lockedFor / 60)} minute(s).`
            : 'Incorrect PIN.',
    });
}

app.get('/api/admin/status', requirePin, (req, res) => {
    const z = store.getZoho();
    res.json({
        demoMode: store.isDemo(),
        zoho: z ? {
            connected: true,
            datacenter: z.datacenter,
            hasLeadScope: !z.grantedScopes || z.grantedScopes.split(/[\s,]+/)
                .some(s => s.toLowerCase().startsWith('zohocrm.modules.leads')),
            hasNoteScope: zoho.canWriteNotes(z) && !noteScopeProblem,
            noteScopeProblem,
            requiredScope: zoho.REQUIRED_SCOPE,
            grantedScopes: z.grantedScopes || '',
        } : { connected: false, requiredScope: zoho.REQUIRED_SCOPE },
        counts: store.counts(),
        photos: store.photoCounts(),
        mail: {
            configured: mail.canSend() && !store.isDemo(),
            to: mail.mailConfig().to,
            ...store.mailCounts(MAIL_KINDS),
        },
        leads: store.getLeads().slice().reverse(),
        contestCount: store.getLeads().filter(l => l.kind === 'contest').length,
    });
});

app.post('/api/admin/zoho/connect', requirePin, async (req, res) => {
    try {
        const existing = store.getZoho() || {};
        const clientId = req.body.clientId || existing.clientId;
        const clientSecret = req.body.clientSecret || existing.clientSecret;
        // Fall back to the STORED datacenter, not to 'com' — a reconnect that
        // omits it must not silently move a .ca org onto the wrong host.
        const datacenter = zoho.normalizeDatacenter(req.body.datacenter || existing.datacenter || 'com');
        const code = req.body.code;
        if (!code) return res.status(400).json({ error: 'Paste the one-time code from the Zoho API console.' });
        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: 'Client ID and Client Secret are required the first time you connect.' });
        }
        const { refreshToken, grantedScopes } = await zoho.exchangeCode({ clientId, clientSecret, code, datacenter });
        store.setZoho({ clientId, clientSecret, refreshToken, datacenter, grantedScopes });
        zoho._resetTokenCache();
        setImmediate(pushPending);
        res.json({ ok: true, connected: true, datacenter, grantedScopes });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

/**
 * Prove the Zoho connection works, without writing anything.
 *
 * Read-only on purpose: a connection self-test that leaves junk leads behind
 * is one nobody runs. The one thing worth knowing before doors open is
 * whether this copy's token still has full Leads access.
 */
app.get('/api/admin/verify', requirePin, async (req, res) => {
    const cfg = store.getZoho();
    if (!cfg) return res.json({ connected: false, detail: 'No Zoho connection on this server.' });
    const result = await zoho.verifyConnection(cfg);
    // A proven read clears a stale refusal — the token has evidently changed.
    if (result.canReadLeads) { noteScopeProblem = null; attachmentScopeProblem = null; }
    res.json({ connected: true, datacenter: cfg.datacenter, ...result });
});

/**
 * Prove the whole chain, end to end, against Zoho itself.
 *
 * Everything else in this app reports what it BELIEVES happened. This asks
 * the CRM what it actually holds and compares it to the append-only journal,
 * which is the one file that is never rewritten. If those two agree, nothing
 * has been lost — and that is a claim worth being able to make out loud
 * rather than assume.
 */
app.get('/api/admin/audit', requirePin, async (req, res) => {
    const cfg = store.getZoho();
    const journalAudit = store.auditJournal();
    const leads = store.getLeads();
    const out = {
        journal: {
            recorded: journalAudit.journalled,
            live: journalAudit.live,
            // Anything the journal saw that the working file no longer has.
            missingFromWorkingSet: journalAudit.missing.map(e => ({
                id: e.id, name: [e.fields?.firstName, e.fields?.lastName].filter(Boolean).join(' '),
                receivedAt: e.receivedAt,
            })),
        },
        zoho: { checked: false },
        photos: store.photoCounts(),
    };

    if (cfg) {
        try {
            // Every CRM-bound brand's Lead_Source, not just the first. With
            // one source, every OTHER brand's synced leads would be reported
            // as missing from the CRM — a false alarm on every sweep.
            const sources = [...new Set([...CRM_KINDS].map((k) => {
                try { return formConfig(k).show.leadSource; } catch { return null; }
            }).filter(Boolean))];
            const found = await Promise.all(sources.map(src => zoho.listLeadIdsBySource(cfg, src)));
            const inCrm = new Set(found.flatMap(set => [...set]));
            const claimed = leads.filter(l => l.zoho.status === 'synced' && l.zoho.leadId);
            // A lead we believe we sent, that Zoho does not have. Deleted by
            // hand, or never really landed — either way, worth knowing.
            const vanished = claimed.filter(l => !inCrm.has(l.zoho.leadId));
            out.zoho = {
                checked: true,
                sources,
                inCrmForThisShow: inCrm.size,
                weBelieveSynced: claimed.length,
                notYetSent: leads.filter(l => l.zoho.status !== 'synced').length,
                missingFromCrm: vanished.map(l => ({
                    id: l.id, leadId: l.zoho.leadId,
                    name: [l.fields.firstName, l.fields.lastName].filter(Boolean).join(' '),
                })),
            };
        } catch (err) {
            out.zoho = { checked: false, error: err.message };
        }
    }

    out.ok = out.journal.missingFromWorkingSet.length === 0
        && (!out.zoho.checked || out.zoho.missingFromCrm.length === 0);
    res.json(out);
});

/**
 * Start fresh for a new show. Archives, never deletes (see store.archiveAll),
 * and demands a typed phrase as well as the PIN: this empties the page the
 * booth depends on, so it must not be one stray tap.
 */
app.post('/api/admin/archive', requirePin, (req, res) => {
    if (req.body?.confirm !== 'START FRESH') {
        return res.status(400).json({ error: 'Type START FRESH to confirm.' });
    }
    const summary = store.archiveAll();
    console.log(`[admin] started fresh — ${summary.leads} lead(s) archived to ${summary.archivedTo}`);
    res.json({ ok: true, ...summary });
});

/** Pull back anything the journal has that the working file lost. */
app.post('/api/admin/restore', requirePin, (req, res) => {
    const n = store.restoreFromJournal();
    if (n) setImmediate(pushPending);
    res.json({ ok: true, restored: n });
});

/** The raw append-only journal, for an off-site copy. */
app.get('/api/admin/journal.jsonl', requirePin, (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', 'attachment; filename="intake-journal.jsonl"');
    res.send(store.getJournal().map(e => JSON.stringify(e)).join('\n'));
});

app.post('/api/admin/retry', requirePin, (req, res) => {
    // Clear the sticky flag: the admin is retrying because they believe they
    // fixed the token, and a stale banner would hide whether they did.
    noteScopeProblem = null;
    attachmentScopeProblem = null;
    zoho._resetTokenCache(); // a new token may be waiting behind the old cache
    const n = store.retry(req.body?.id);
    setImmediate(pushPending);
    setImmediate(pushPhotos);
    setImmediate(pushMail);
    res.json({ ok: true, retried: n });
});

app.get('/api/admin/export.csv', requirePin, (req, res) => {
    // ?kind=contest exports the prize draw instead of the sales leads. Two
    // separate lists, because they are two separate things: one gets called
    // by an estimator, the other gets a name pulled out of a hat.
    const kind = isKind(req.query.kind) ? req.query.kind : 'enquiry';
    const cfg = formConfig(kind);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // A prize draw has no priority, no photographs and never goes to the CRM,
    // so those columns would be dead weight in a list somebody is going to
    // pull a winner out of.
    const isContest = kind === 'contest';
    const isMail = MAIL_KINDS.has(kind);
    const header = isContest
        ? ['enteredAt', ...cfg.fields.map(f => f.id)]
        : isMail
            ? ['receivedAt', 'boothRating', ...cfg.fields.map(f => f.id), 'emailStatus', 'emailedAt', 'emailError']
            : ['receivedAt', 'boothRating', ...cfg.fields.map(f => f.id), 'photos', 'zohoStatus', 'zohoLeadId', 'zohoError'];

    const answers = (l) => cfg.fields.map(f => {
        const v = l.fields[f.id];
        return Array.isArray(v) ? v.join('; ') : v ?? '';
    });

    const rows = store.getLeads().filter(l => (l.kind || 'enquiry') === kind).map(l => isContest
        ? [l.receivedAt, ...answers(l)]
        : isMail
        ? [l.receivedAt, l.fields._boothRating || '', ...answers(l),
            l.mail?.status || 'pending', l.mail?.sentAt || '', l.mail?.error || '']
        : [
            l.receivedAt,
            l.fields._boothRating || '',
            ...answers(l),
            (l.photos || []).filter(p => p.status === 'uploaded').length,
            l.zoho.status, l.zoho.leadId || '', l.zoho.error || '',
        ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${{ contest: 'prize-draw-entries', ribit: 'code-compass-demo-requests' }[kind] || 'homeshow-leads'}.csv"`);
    res.send([header, ...rows].map(r => r.map(esc).join(',')).join('\r\n'));
});

// ---------- background pusher ----------

let pushing = false;
// Sticky: set when Zoho refuses a note for scope reasons. An env-var
// connection carries no granted-scope list, so the app cannot know the token
// is short until a write is refused — and a per-lead log line is invisible at
// a booth. This turns it into a banner on the admin page and the kiosk.
let noteScopeProblem = null;
let attachmentScopeProblem = null;

async function pushPending() {
    if (pushing) return;
    const cfg = store.getZoho();
    if (!cfg) return; // not connected yet — leads wait on disk, nothing is lost
    pushing = true;
    try {
        for (const lead of store.pendingLeads()) {
            // Per lead, not per sweep: each brand carries its own Lead_Source,
            // owner and note wording. Hoisting this out of the loop silently
            // filed every brand's leads under the first one.
            let formCfg;
            try {
                formCfg = formConfig(lead.kind);
            } catch (err) {
                // 'failed' so it shows in the declined count and the admin
                // Retry picks it up once the config is fixed. A status of its
                // own would sit invisible behind "Awaiting transfer" forever.
                store.updateLead(lead.id, { status: 'failed', error: `config for "${lead.kind}" is invalid: ${err.message}` });
                continue;
            }
            // Prize-draw entries stay out of the CRM. They are exported as
            // their own CSV instead — a draw entrant has not asked for a
            // quote, and mixing them into the show's leads would spoil both.
            if (!CRM_KINDS.has(lead.kind || 'enquiry')) {
                store.updateLead(lead.id, { status: 'local', syncedAt: null });
                continue;
            }
            // Backoff: skip a lead tried recently; the interval sweep returns.
            const wait = Math.min((lead.zoho.attempts || 0) * 2, 15) * 60 * 1000;
            if (lead.zoho.lastTriedAt && Date.now() - Date.parse(lead.zoho.lastTriedAt) < wait) continue;
            try {
                const notesOk = zoho.canWriteNotes(cfg);
                // Already-created lead whose NOTE failed: post just the note,
                // never a second lead.
                let leadId = lead.zoho.leadId;
                if (!leadId) {
                    // withDetail only when notes are unavailable — the detail
                    // has to live somewhere, so it falls back to Description.
                    const record = zoho.buildLeadRecord(lead, formCfg, { withDetail: !notesOk });
                    const created = await zoho.createLead(cfg, record);
                    leadId = created.leadId;
                    if (created.droppedField) {
                        // Say it once, loudly: the lead is in, but not filed
                        // where they asked, and only they can add the picklist
                        // value in Zoho.
                        console.warn(`[zoho] "${created.droppedField.value}" is not a valid ${created.droppedField.field} in your CRM — lead filed without it. Add the value in Zoho: Setup → Modules → Leads → that field.`);
                    }
                    store.updateLead(lead.id, { leadId, droppedField: created.droppedField?.field });
                }

                // Each part remembers that it landed. A retry for a failed
                // tag must not post the note a second time, and the other way
                // round — a duplicate note is the CRM equivalent of a
                // customer being asked the same question twice.
                let noteError, noteDone = !!lead.zoho.noteDone;
                if (notesOk && !noteDone) {
                    try {
                        await zoho.createNote(cfg, leadId, zoho.buildNote(lead, formCfg));
                        noteDone = true;
                    } catch (noteErr) {
                        noteError = noteErr.message;
                        if (noteErr.scopeProblem) noteScopeProblem = noteErr.message;
                        console.warn(`[zoho] lead ${leadId} created but note failed: ${noteErr.message}`);
                    }
                }

                // The show's tag is how its leads are found: they land in the
                // ordinary first column and are searchable by tag, instead of
                // being parked in a status column made for one weekend.
                let tagError, tagsDone = !!lead.zoho.tagsDone;
                const tags = formCfg.show.tags || [];
                if (tags.length && !tagsDone) {
                    try {
                        await zoho.addTags(cfg, leadId, tags);
                        tagsDone = true;
                    } catch (tagErr) {
                        tagError = tagErr.message;
                        console.warn(`[zoho] lead ${leadId} created but tag failed: ${tagErr.message}`);
                    }
                }

                store.updateLead(lead.id, {
                    status: 'synced', leadId, syncedAt: new Date().toISOString(),
                    error: undefined, noteError, noteDone, tagError, tagsDone,
                });
                console.log(`[zoho] synced lead ${lead.id} → ${leadId}${noteError ? ' (note FAILED)' : ''}${tagError ? ' (tag FAILED)' : ''}`);
            } catch (err) {
                store.updateLead(lead.id, {
                    // Permanent = Zoho rejected the data; retrying identical data
                    // forever just burns the log. Admin "retry" can force it.
                    status: err.permanent ? 'failed' : 'pending',
                    attempts: (lead.zoho.attempts || 0) + 1,
                    lastTriedAt: new Date().toISOString(),
                    error: err.message,
                });
                console.warn(`[zoho] push failed for ${lead.id}: ${err.message}`);
            }
        }
    } finally {
        pushing = false;
    }
}

/**
 * Email waiting Code Compass leads to our own inbox.
 *
 * The same shape as the Zoho push: durable on disk first, delivered after,
 * backed off when it fails, and never lost when it cannot be sent at all.
 * Demo mode sends nothing, for the same reason it reaches no CRM.
 */
let mailing = false;
async function pushMail() {
    if (mailing || store.isDemo() || !mail.canSend()) return;
    mailing = true;
    try {
        for (const lead of store.pendingMail(MAIL_KINDS)) {
            const m = lead.mail || { attempts: 0 };
            const wait = Math.min((m.attempts || 0) * 2, 15) * 60 * 1000;
            if (m.lastTriedAt && Date.now() - Date.parse(m.lastTriedAt) < wait) continue;
            try {
                const cfg = formConfig(lead.kind);
                const message = mail.buildLeadEmail(lead, cfg, zoho.buildNote(lead, cfg).Note_Content);
                const sent = await mail.sendLeadEmail(message);
                store.updateMail(lead.id, { status: 'sent', sentAt: new Date().toISOString(), id: sent.id, error: undefined });
                console.log(`[mail] ${lead.kind} lead ${lead.id} emailed to ${sent.to}`);
            } catch (err) {
                store.updateMail(lead.id, {
                    status: err.permanent ? 'failed' : 'pending',
                    attempts: (m.attempts || 0) + 1,
                    lastTriedAt: new Date().toISOString(),
                    error: err.message,
                });
                console.warn(`[mail] lead ${lead.id} not sent: ${err.message}`);
            }
        }
    } finally {
        mailing = false;
    }
}

/**
 * Push held photographs onto their leads in Zoho.
 *
 * Separate from pushPending because a photograph can only attach once the
 * lead exists in the CRM — a customer who uploads while the lead is still
 * queued must not lose the photo, so it simply waits its turn.
 */
let pushingPhotos = false;

// The gallery manifest, read once and cached — it only changes when someone
// re-runs `npm run gallery`.
/**
 * Bytes for one inspiration photograph.
 *
 * The cached copy shipped with the app is the SOURCE OF TRUTH, not a
 * fallback. Fetching the full-size original from ironwoodstairs.com looked
 * fine in development and failed silently in production: the site's bot
 * protection served this server a CAPTCHA page — HTML, 264 bytes, HTTP 200 —
 * which was duly attached to leads as "Inspiration 1.jpg". Every inspiration
 * attachment made from Render was a broken file.
 *
 * A larger original is still worth having when it can be had, so we try, but
 * only accept it if it is genuinely a bigger image than the one we hold.
 */
async function inspirationBytes(photo) {
    const local = fs.readFileSync(path.join(__dirname, 'public', photo.thumb));
    try {
        const res = await fetch(photo.full, {
            // A plain fetch reads as a bot; this at least gets past the
            // simpler challenges.
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return local;
        const buf = Buffer.from(await res.arrayBuffer());
        const looksJpeg = buf.length > 20000 && buf[0] === 0xFF && buf[1] === 0xD8;
        if (!looksJpeg) {
            console.warn(`[gallery] ${photo.id}: website returned ${buf.length} bytes of non-image (bot challenge?) — using the cached copy`);
            return local;
        }
        return buf.length > local.length ? buf : local;
    } catch (err) {
        console.warn(`[gallery] ${photo.id}: ${err.message} — using the cached copy`);
        return local;
    }
}

let galleryCache = null;
function galleryPhoto(id) {
    if (!galleryCache) {
        try {
            galleryCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'gallery.json'), 'utf8'));
        } catch { galleryCache = { photos: [] }; }
    }
    return (galleryCache.photos || []).find(p => p.id === id) || null;
}

async function pushPhotos() {
    if (pushingPhotos) return;
    const cfg = store.getZoho();
    if (!cfg) return;
    pushingPhotos = true;
    try {
        for (const lead of store.leadsWithPendingPhotos()) {
            if (!lead.zoho.leadId) continue; // lead not in Zoho yet — wait
            for (const photo of (lead.photos || []).filter(p => p.status === 'pending')) {
                try {
                    const buffer = store.readPhoto(photo.file);
                    await zoho.createAttachment(cfg, lead.zoho.leadId, {
                        buffer, filename: photo.filename, mimeType: photo.mimeType,
                    });
                    store.markPhoto(lead.id, photo.file, { status: 'uploaded' });
                    console.log(`[zoho] photograph attached to lead ${lead.zoho.leadId}`);
                } catch (err) {
                    if (err.scopeProblem) attachmentScopeProblem = err.message;
                    store.markPhoto(lead.id, photo.file, {
                        status: (photo.attempts || 0) >= 4 ? 'failed' : 'pending',
                        attempts: (photo.attempts || 0) + 1,
                        error: err.message,
                    });
                    console.warn(`[zoho] photograph upload failed: ${err.message}`);
                }
            }
        }
        // Inspiration photographs the visitor picked from Ironwood's own
        // gallery. Fetched full-size from the website at attach time rather
        // than shipped with the kiosk — the booth only ever holds thumbnails.
        for (const lead of store.leadsWithPendingInspiration()) {
            if (!lead.zoho.leadId) continue;
            const picks = lead.fields._inspiration || [];
            for (let i = 0; i < picks.length; i++) {
                if ((lead.inspirationPushed || []).includes(picks[i])) continue;
                const photo = galleryPhoto(picks[i]);
                if (!photo) { store.markInspirationPushed(lead.id, picks[i]); continue; }
                try {
                    const buffer = await inspirationBytes(photo);
                    await zoho.createAttachment(cfg, lead.zoho.leadId, {
                        buffer, mimeType: 'image/jpeg',
                        // Numbered so the CRM lists them in the order chosen.
                        filename: `Inspiration ${i + 1}.jpg`,
                    });
                    store.markInspirationPushed(lead.id, picks[i]);
                    console.log(`[zoho] inspiration ${i + 1} attached to lead ${lead.zoho.leadId}`);
                } catch (err) {
                    console.warn(`[zoho] inspiration attach failed: ${err.message}`);
                }
            }
        }

        // Once the photographs are filed, record what may be done with them.
        // After the attachments, so the note never claims photographs that
        // did not arrive.
        for (const lead of store.unpushedPermissions()) {
            const perm = lead.photoPermission;
            const entries = perm.log.filter(e => !e.pushed);
            const count = entries.reduce((n, e) => n + (e.count || 0), 0);
            if (!count) { store.markPermissionPushed(lead.id); continue; }
            try {
                await zoho.createNote(cfg, lead.zoho.leadId, zoho.buildPhotoPermissionNote({
                    count,
                    mayShare: perm.mayShare,
                    statement: perm.statement,
                    at: new Date().toISOString(),
                    showName: formConfig(lead.kind).show.name,
                }));
                store.markPermissionPushed(lead.id);
            } catch (err) {
                console.warn(`[zoho] photograph permission note failed: ${err.message}`);
            }
        }
    } finally {
        pushingPhotos = false;
    }
}

if (require.main === module) {
    setInterval(pushPending, 15 * 1000);   // tighter than the hold, so a held lead moves promptly
    setInterval(pushPhotos, 60 * 1000);
    setInterval(pushMail, 15 * 1000);
    app.listen(PORT, '0.0.0.0', () => {
        const nets = Object.values(os.networkInterfaces()).flat()
            .filter(n => n && n.family === 'IPv4' && !n.internal)
            .map(n => `http://${n.address}:${PORT}`);
        if (store.isDemo()) {
            console.log('=== DEMO MODE — this build cannot reach Zoho CRM. ===');
            console.log('    Leads are captured, queued and exportable as CSV, and go nowhere else.');
        }
        console.log(`Home-show intake running on port ${PORT}`);
        console.log(`  Kiosk (open this on the iPad): ${nets[0] || `http://localhost:${PORT}`}`);
        for (const url of nets.slice(1)) console.log(`                            or: ${url}`);
        console.log(`  Admin: ${nets[0] || `http://localhost:${PORT}`}/admin.html`);
        console.log(`  Admin PIN: ${ADMIN_PIN}`);
        if (PIN_WAS_GENERATED) {
            console.warn('');
            console.warn('  ****************************************************************');
            console.warn('  *  ADMIN_PIN is NOT set, so the PIN above was invented and     *');
            console.warn('  *  CHANGES EVERY RESTART. On a hosted server that means the    *');
            console.warn('  *  PIN in your logs stops working the moment it restarts.      *');
            console.warn('  *  Set ADMIN_PIN in the environment.                           *');
            console.warn('  ****************************************************************');
            console.warn('');
        } else if (PIN_IS_WEAK) {
            console.warn('  NOTE: that PIN is short. This page shows customer contact details.');
        }
        pushPending();
    });
}

module.exports = { app, pushPending, pushMail };
