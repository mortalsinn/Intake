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

const { createStore } = require('./lib/store');
const { validateLead } = require('./lib/validate');
const zoho = require('./lib/zoho');

const PORT = Number(process.env.PORT) || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR);

// Admin PIN: set ADMIN_PIN in the environment to keep it stable; otherwise a
// random one is generated and printed at boot. Never a shipped default —
// the admin page shows customer PII.
const ADMIN_PIN = process.env.ADMIN_PIN || String(crypto.randomInt(100000, 999999));

const formConfigPath = path.join(__dirname, 'config', 'form.json');
const formConfig = () => JSON.parse(fs.readFileSync(formConfigPath, 'utf8'));

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- kiosk ----------

app.get('/api/form', (req, res) => {
    try {
        res.json(formConfig());
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
        zohoConnected: !!z,
        // A refused write outranks the optimistic scope guess: proof beats
        // assumption, and env-var connections can only be proven this way.
        zohoNotes: z ? (zoho.canWriteNotes(z) && !noteScopeProblem) : false,
        counts: store.counts(),
    });
});

app.post('/api/leads', (req, res) => {
    let cfg;
    try {
        cfg = formConfig();
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    const errors = validateLead(req.body, cfg);
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

    const { added } = store.addLead({
        id: req.body.id,
        submittedAt: req.body.submittedAt,
        fields: req.body.fields,
    });
    // The disk write above is the durable receipt — respond now, push later.
    // Retries from the iPad land here again with the same id and dedupe.
    res.json({ ok: true, duplicate: !added });
    if (added) setImmediate(pushPending);
});

// ---------- admin ----------

function requirePin(req, res, next) {
    if (req.get('x-admin-pin') === ADMIN_PIN) return next();
    res.status(401).json({ error: 'Wrong PIN' });
}

app.get('/api/admin/status', requirePin, (req, res) => {
    const z = store.getZoho();
    res.json({
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
        leads: store.getLeads().slice().reverse(),
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

app.post('/api/admin/retry', requirePin, (req, res) => {
    // Clear the sticky flag: the admin is retrying because they believe they
    // fixed the token, and a stale banner would hide whether they did.
    noteScopeProblem = null;
    zoho._resetTokenCache(); // a new token may be waiting behind the old cache
    const n = store.retry(req.body?.id);
    setImmediate(pushPending);
    res.json({ ok: true, retried: n });
});

app.get('/api/admin/export.csv', requirePin, (req, res) => {
    const cfg = formConfig();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // boothRating is second, next to the name — it's the column you sort by
    // on Monday morning, not something to hunt for at the far right.
    const header = ['receivedAt', 'boothRating', ...cfg.fields.map(f => f.id), 'zohoStatus', 'zohoLeadId', 'zohoError'];
    const rows = store.getLeads().map(l => [
        l.receivedAt,
        l.fields._boothRating || '',
        ...cfg.fields.map(f => {
            const v = l.fields[f.id];
            return Array.isArray(v) ? v.join('; ') : v ?? '';
        }),
        l.zoho.status, l.zoho.leadId || '', l.zoho.error || '',
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="homeshow-leads.csv"');
    res.send([header, ...rows].map(r => r.map(esc).join(',')).join('\r\n'));
});

// ---------- background pusher ----------

let pushing = false;
// Sticky: set when Zoho refuses a note for scope reasons. An env-var
// connection carries no granted-scope list, so the app cannot know the token
// is short until a write is refused — and a per-lead log line is invisible at
// a booth. This turns it into a banner on the admin page and the kiosk.
let noteScopeProblem = null;

async function pushPending() {
    if (pushing) return;
    const cfg = store.getZoho();
    if (!cfg) return; // not connected yet — leads wait on disk, nothing is lost
    pushing = true;
    try {
        const formCfg = formConfig();
        for (const lead of store.pendingLeads()) {
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

                let noteError;
                if (notesOk) {
                    try {
                        await zoho.createNote(cfg, leadId, zoho.buildNote(lead, formCfg));
                    } catch (noteErr) {
                        noteError = noteErr.message;
                        if (noteErr.scopeProblem) noteScopeProblem = noteErr.message;
                        console.warn(`[zoho] lead ${leadId} created but note failed: ${noteErr.message}`);
                    }
                }

                store.updateLead(lead.id, {
                    status: 'synced', leadId, syncedAt: new Date().toISOString(),
                    error: undefined, noteError,
                });
                console.log(`[zoho] synced lead ${lead.id} → ${leadId}${noteError ? ' (note FAILED)' : ''}`);
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

if (require.main === module) {
    setInterval(pushPending, 45 * 1000);
    app.listen(PORT, '0.0.0.0', () => {
        const nets = Object.values(os.networkInterfaces()).flat()
            .filter(n => n && n.family === 'IPv4' && !n.internal)
            .map(n => `http://${n.address}:${PORT}`);
        console.log(`Home-show intake running on port ${PORT}`);
        console.log(`  Kiosk (open this on the iPad): ${nets[0] || `http://localhost:${PORT}`}`);
        for (const url of nets.slice(1)) console.log(`                            or: ${url}`);
        console.log(`  Admin: ${nets[0] || `http://localhost:${PORT}`}/admin.html`);
        console.log(`  Admin PIN: ${ADMIN_PIN}${process.env.ADMIN_PIN ? '' : '  (random this boot — set ADMIN_PIN in .env to fix it)'}`);
        pushPending();
    });
}

module.exports = { app, pushPending };
