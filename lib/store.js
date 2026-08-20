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
const crypto = require('crypto');

function atomicWrite(file, obj) {
    // Recreate the directory every write, not just at boot — losing a lead
    // because someone tidied up data/ while the server ran is not acceptable.
    fs.mkdirSync(path.dirname(file), { recursive: true });
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

// How long a new lead waits before going to Zoho, so a staff priority tap
// can still reach it. Long enough for a deliberate tap, short enough that
// nobody notices — and the lead is already durable on disk throughout.
const HOLD_MS = 20 * 1000;

function createStore(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const leadsFile = path.join(dataDir, 'leads.json');
    const zohoFile = path.join(dataDir, 'zoho.json');
    const photoDir = path.join(dataDir, 'photos');

    let leads = readJson(leadsFile, []);

    const persist = () => atomicWrite(leadsFile, leads);

    return {
        /**
         * Record a lead. Dedupes on the client-generated id, which is what
         * makes the iPad's retry loop safe: the same submission arriving
         * three times over flaky wifi is stored (and pushed to Zoho) once.
         */
        addLead({ id, submittedAt, fields, uploadToken }) {
            const existing = leads.find(l => l.id === id);
            if (existing) return { added: false, uploadToken: existing.uploadToken };
            const token = uploadToken || crypto.randomBytes(9).toString('base64url');
            leads.push({
                id,
                submittedAt: submittedAt || new Date().toISOString(),
                receivedAt: new Date().toISOString(),
                fields: fields || {},
                // Lets the customer send photographs from their own phone
                // later. Random and unguessable; expiry is enforced on use.
                uploadToken: token,
                photos: [],
                // A short grace period before the Zoho push, so the staff
                // priority tap lands inside the same record rather than
                // arriving after the note has already been written.
                holdUntil: Date.now() + HOLD_MS,
                zoho: { status: 'pending', attempts: 0 },
            });
            persist();
            return { added: true, uploadToken: token };
        },

        /** The lead a customer's upload link belongs to, if still valid. */
        leadByUploadToken(token, { maxAgeDays = 7 } = {}) {
            if (!token) return null;
            const lead = leads.find(l => l.uploadToken === token);
            if (!lead) return null;
            const age = Date.now() - Date.parse(lead.receivedAt);
            if (age > maxAgeDays * 24 * 60 * 60 * 1000) return null;
            return lead;
        },

        /**
         * Hold a photograph until it can be pushed to Zoho.
         *
         * Stored as a file beside the lead log rather than inline, so the
         * JSON does not balloon to megabytes per entry.
         */
        addPhoto(leadId, { buffer, filename, mimeType }) {
            const lead = leads.find(l => l.id === leadId);
            if (!lead) return null;
            fs.mkdirSync(photoDir, { recursive: true });
            const name = `${leadId}_${crypto.randomBytes(4).toString('hex')}.jpg`;
            fs.writeFileSync(path.join(photoDir, name), buffer);
            const rec = { file: name, filename: filename || name, mimeType: mimeType || 'image/jpeg', status: 'pending', bytes: buffer.length };
            lead.photos = lead.photos || [];
            lead.photos.push(rec);
            persist();
            return rec;
        },

        readPhoto: (file) => fs.readFileSync(path.join(photoDir, file)),

        /** Leads holding photographs that have not reached Zoho yet. */
        leadsWithPendingPhotos: () =>
            leads.filter(l => (l.photos || []).some(p => p.status === 'pending')),

        markPhoto(leadId, file, patch) {
            const lead = leads.find(l => l.id === leadId);
            const photo = lead?.photos?.find(p => p.file === file);
            if (!photo) return null;
            Object.assign(photo, patch);
            // A photograph that reached Zoho no longer needs its local copy.
            if (patch.status === 'uploaded') {
                try { fs.unlinkSync(path.join(photoDir, file)); } catch { /* already gone */ }
            }
            persist();
            return photo;
        },

        photoCounts() {
            let pending = 0, uploaded = 0, failed = 0;
            for (const l of leads) for (const p of l.photos || []) {
                if (p.status === 'uploaded') uploaded++;
                else if (p.status === 'failed') failed++;
                else pending++;
            }
            return { pending, uploaded, failed };
        },

        /** Record the staff priority tap, if it beats the Zoho push. */
        setPriority(id, priority) {
            const lead = leads.find(l => l.id === id);
            if (!lead) return null;
            lead.fields._boothRating = priority;
            persist();
            return lead;
        },

        /** Stop holding this lead back — push it at the next sweep. */
        releaseHold(id) {
            const lead = leads.find(l => l.id === id);
            if (!lead) return null;
            lead.holdUntil = null;
            persist();
            return lead;
        },

        updateLead(id, patchZoho) {
            const lead = leads.find(l => l.id === id);
            if (!lead) return null;
            lead.zoho = { ...lead.zoho, ...patchZoho };
            persist();
            return lead;
        },

        getLeads: () => leads.slice(),

        // A lead inside its grace period is deliberately withheld — it is not
        // stuck, it is waiting a few seconds for a possible priority tap.
        pendingLeads: () => leads.filter(l =>
            l.zoho.status === 'pending' && !(l.holdUntil && Date.now() < l.holdUntil)),

        /**
         * Put incomplete leads back in the pending pool (admin retry).
         *
         * "Incomplete" includes a SYNCED lead whose note failed — the lead is
         * in the CRM but its booth detail never arrived, and that was
         * previously unrecoverable: retry skipped anything already synced, so
         * the note could never be posted. The pusher keeps the existing
         * leadId, so re-running posts only the missing note.
         */
        retry(id) {
            let n = 0;
            // Photographs get retried too. They fail for the same reasons a
            // note does — usually a token that has since been fixed — and a
            // photograph stuck at 'failed' is otherwise unrecoverable.
            for (const lead of leads) {
                if (id && lead.id !== id) continue;
                for (const photo of lead.photos || []) {
                    if (photo.status === 'failed') {
                        photo.status = 'pending';
                        photo.attempts = 0;
                        photo.error = undefined;
                        n++;
                    }
                }
            }
            for (const lead of leads) {
                const incomplete = lead.zoho.status !== 'synced' || lead.zoho.noteError;
                if (incomplete && (!id || lead.id === id)) {
                    lead.zoho.status = 'pending';
                    lead.zoho.error = undefined;
                    lead.zoho.noteError = undefined;
                    // Clear the grace period too. It exists to catch a staff
                    // priority tap seconds after capture; on a deliberate
                    // retry it would only delay the fix.
                    lead.holdUntil = null;
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
        //
        // Env vars are the fallback for hosts with ephemeral disks (Render,
        // Railway…): a deploy wipes data/, and without this the show would
        // start with Zoho silently disconnected. The admin-page connect flow
        // still works and takes precedence once used.
        getZoho: () => {
            const fromFile = readJson(zohoFile, null);
            if (fromFile) return fromFile;
            const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_DC } = process.env;
            if (ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN) {
                return {
                    clientId: ZOHO_CLIENT_ID,
                    clientSecret: ZOHO_CLIENT_SECRET,
                    refreshToken: ZOHO_REFRESH_TOKEN,
                    datacenter: ZOHO_DC || 'com',
                    grantedScopes: '', // unknown; scope check treats absent as OK
                };
            }
            return null;
        },
        setZoho(cfg) {
            atomicWrite(zohoFile, { ...cfg, updatedAt: new Date().toISOString() });
        },
    };
}

module.exports = { createStore };
