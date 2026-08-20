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
                const record = zoho.buildLeadRecord(lead, formCfg);
                const { leadId } = await zoho.createLead(cfg, record);
                store.updateLead(lead.id, { status: 'synced', leadId, syncedAt: new Date().toISOString(), error: undefined });
                console.log(`[zoho] synced lead ${lead.id} → ${leadId}`);
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
