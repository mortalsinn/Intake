// ========================================================
// Filename: lib/store.js
// Description: Disk-backed lead log and Zoho connection store.
//
// The disk file is the durability layer between the iPad and
// Zoho: a lead that reaches this store survives the server
// crashing, the wifi dying, and Zoho being down for the whole
// show. Everything is synchronous fs on purpose — a home show
// produces hundreds of leads, not millions, and a synchronous
// write is the simplest thing that cannot interleave.
// ========================================================
const fs = require('fs');
const path = require('path');

function atomicWrite(file, obj) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function createStore(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const leadsFile = path.join(dataDir, 'leads.json');
    const zohoFile = path.join(dataDir, 'zoho.json');

    let leads = readJson(leadsFile, []);

    const persist = () => atomicWrite(leadsFile, leads);

    return {
        /**
         * Record a lead. Dedupes on the client-generated id, which is what
         * makes the iPad's retry loop safe: the same submission arriving
         * three times over flaky wifi is stored (and pushed to Zoho) once.
         */
        addLead({ id, submittedAt, fields }) {
            if (leads.some(l => l.id === id)) return { added: false };
            leads.push({
                id,
                submittedAt: submittedAt || new Date().toISOString(),
                receivedAt: new Date().toISOString(),
                fields: fields || {},
                zoho: { status: 'pending', attempts: 0 },
            });
            persist();
            return { added: true };
        },

        updateLead(id, patchZoho) {
            const lead = leads.find(l => l.id === id);
            if (!lead) return null;
            lead.zoho = { ...lead.zoho, ...patchZoho };
            persist();
            return lead;
        },

        getLeads: () => leads.slice(),

        pendingLeads: () => leads.filter(l => l.zoho.status === 'pending'),

        /** Put failed leads back in the pending pool (admin retry). */
        retry(id) {
            let n = 0;
            for (const lead of leads) {
                if (lead.zoho.status !== 'synced' && (!id || lead.id === id)) {
                    lead.zoho.status = 'pending';
                    lead.zoho.error = undefined;
                    n++;
                }
            }
            if (n) persist();
            return n;
        },

        counts() {
            const c = { total: leads.length, synced: 0, pending: 0, failed: 0 };
            for (const l of leads) c[l.zoho.status] = (c[l.zoho.status] || 0) + 1;
            return c;
        },

        // ---- Zoho connection (client id/secret/refresh token) ----
        // Lives in data/, which is gitignored; the refresh token is the
        // long-lived secret and never goes back to any browser.
        getZoho: () => readJson(zohoFile, null),
        setZoho(cfg) {
            atomicWrite(zohoFile, { ...cfg, updatedAt: new Date().toISOString() });
        },
    };
}

module.exports = { createStore };
