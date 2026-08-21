// ========================================================
// Filename: lib/zoho.js
// Description: The Zoho CRM Leads side of the intake app.
//
// Mirrors the patterns in AscendOS backend/services/zohoCrm.js
// and zohoController.js: OAuth lives on accounts.zoho.<dc>,
// data lives on zohoapis.<dc>, and setup is the self-client
// paste-the-code flow. This app holds its OWN connection —
// Zoho freezes a token's scopes at code-generation time, and
// the AscendOS token has no Leads scope.
// ========================================================

const API_HOST = Object.freeze({
    com: 'https://www.zohoapis.com',
    eu: 'https://www.zohoapis.eu',
    in: 'https://www.zohoapis.in',
    'com.au': 'https://www.zohoapis.com.au',
    jp: 'https://www.zohoapis.jp',
    ca: 'https://www.zohoapis.ca',
    'com.cn': 'https://www.zohoapis.com.cn',
    sa: 'https://www.zohoapis.sa',
});

const DATACENTERS = Object.keys(API_HOST);

// The scopes this app needs. Shown verbatim on the admin screen so the
// self-client is generated with exactly them — a wrong scope string is the
// most common way a Zoho connection comes back green and then can't write.
//
// Notes are a SEPARATE module from Leads in Zoho, with its own scope. The
// booth detail is written as a Note (that is where the follow-up crew reads
// and replies), so without notes.CREATE the lead lands bare.
// leads.ALL rather than leads.CREATE, and the reason is not obvious:
// attaching a photograph hangs off /Leads/{id}/Attachments, which Zoho
// treats as modifying an existing lead. Their formula is "module scope AND
// attachments scope", and leads.CREATE only covers creating a lead — so
// the upload returns OAUTH_SCOPE_MISMATCH while looking like a bad token.
// Verified against live CRM: leads.CREATE + attachments.CREATE is refused.
const LEAD_SCOPE = 'ZohoCRM.modules.leads.ALL';
const NOTE_SCOPE = 'ZohoCRM.modules.notes.CREATE';
// Photographs the customer sends from their own phone land as Attachments —
// a third module, and therefore a third scope.
const ATTACHMENT_SCOPE = 'ZohoCRM.modules.attachments.CREATE';
const REQUIRED_SCOPE = `${LEAD_SCOPE},${NOTE_SCOPE},${ATTACHMENT_SCOPE}`;

/** Does this connection's token allow writing Notes? */
function canWriteNotes(cfg) {
    // Absent granted-scope string means an env-var connection, where we
    // cannot know — try it, and the caller's fallback handles a refusal.
    if (!cfg || !cfg.grantedScopes) return true;
    return cfg.grantedScopes.split(/[\s,]+/)
        .some(s => /^zohocrm\.modules\.(notes|all)\./i.test(s));
}

const normalizeDatacenter = (dc) => (DATACENTERS.includes(dc) ? dc : 'com');
const apiBase = (dc) => `${API_HOST[normalizeDatacenter(dc)]}/crm/v7`;

/**
 * Trade the one-time self-client code for a refresh token.
 * The code is single-use and expires in minutes, so a failure here almost
 * always means "generate a fresh one", and the error text says so.
 */
async function exchangeCode({ clientId, clientSecret, code, datacenter }) {
    const res = await fetch(`https://accounts.zoho.${normalizeDatacenter(datacenter)}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // In the body, never the URL: query strings end up in proxy logs.
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
        }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error || !data.refresh_token) {
        const hint = /invalid_code/i.test(data.error || '')
            ? 'That code was already used or has expired. Generate a fresh one in the Zoho API console and paste it within a few minutes.'
            : (data.error || 'Zoho did not return a refresh token.');
        const err = new Error(hint);
        err.status = 400;
        throw err;
    }
    return { refreshToken: data.refresh_token, grantedScopes: data.scope || '' };
}

// Access-token cache: Zoho tokens last an hour; refresh at 50 minutes.
let cached = { token: null, expiresAt: 0, key: '' };

async function accessToken(cfg) {
    const key = `${cfg.clientId}:${cfg.datacenter}`;
    if (cached.token && cached.key === key && Date.now() < cached.expiresAt) return cached.token;
    const res = await fetch(`https://accounts.zoho.${normalizeDatacenter(cfg.datacenter)}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cfg.refreshToken,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
        }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error || !data.access_token) {
        throw new Error(`Zoho auth failed: ${data.error || 'no access token returned'}`);
    }
    cached = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000, key };
    return data.access_token;
}

/** "Thu, Aug 20, 2026 at 9:30 AM" — for humans, in the shop's own timezone. */
function stamp(iso, timeZone) {
    try {
        const tz = timeZone || 'America/Edmonton';
        const d = new Date(iso);
        const date = d.toLocaleDateString('en-CA', {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: tz,
        });
        // en-CA renders "9:30 a.m."; uppercase and de-dot it so the line does
        // not end in a period that collides with the sentence's own.
        const time = d.toLocaleTimeString('en-CA', {
            hour: 'numeric', minute: '2-digit', timeZone: tz,
        }).replace(/\s*([ap])\.?m\.?/i, (m, p) => ` ${p.toUpperCase()}M`);
        return `${date} at ${time}`;
    } catch {
        return iso;
    }
}

/** The answers, as label/value pairs — shared by the Lead and the Note. */
function collectAnswers(lead, formConfig) {
    const standard = {};   // maps onto real Zoho Lead fields
    const answers = [];    // everything else, in form order
    let consent = null;

    for (const field of formConfig.fields) {
        const value = lead.fields[field.id];
        const has = Array.isArray(value) ? value.length > 0 : value != null && String(value).trim() !== '';
        const label = field.crmLabel || field.label;
        if (field.type === 'consent') {
            consent = has && value === true;
        } else if (field.zoho) {
            if (has) {
                standard[field.zoho] = String(value).trim();
                answers.push({ label, value: String(value).trim(), standard: true });
            }
        } else if (has) {
            answers.push({ label, value: Array.isArray(value) ? value.join(', ') : String(value).trim() });
        }
    }
    return { standard, answers, consent };
}

/**
 * Shape one stored lead into a Zoho CRM Lead record. Pure, so it's testable.
 *
 * Fields with a "zoho" key in form.json map onto standard Lead fields. The
 * booth conversation goes in a NOTE (see buildNote) — that is where the
 * follow-up crew reads and replies. Description carries a one-line pointer
 * so a lead never looks empty, or the full detail as a fallback when the
 * token cannot write notes.
 */
function buildLeadRecord(lead, formConfig, { withDetail = false } = {}) {
    const { standard, answers, consent } = collectAnswers(lead, formConfig);
    const record = { ...standard };

    // Zoho refuses a Lead without Last_Name, and many orgs mark Company
    // mandatory too. Neither is a reason to drop a captured lead.
    if (!record.Last_Name) record.Last_Name = record.First_Name || 'Name not provided';
    record.Company = record.Company || formConfig.companyFallback || 'Homeowner';
    // Lead_Source is how the CRM groups where a lead came from — this is what
    // a "Home Show" list view filters on.
    record.Lead_Source = formConfig.show.leadSource || 'Fall Home Show 2026';
    // Must be one of the org's EXISTING Lead Status options. Zoho accepts an
    // undefined value without complaint and stores it, but its Kanban board
    // has no column for it, so those leads pile up under "Unaccounted" with a
    // strike through them. The show name lives in Lead_Source instead, which
    // is the field meant for attribution and which survives the pipeline.
    if (formConfig.show.leadStatus) record.Lead_Status = formConfig.show.leadStatus;

    // Assign every booth lead to one person, so nothing sits in a queue
    // nobody owns over a show weekend. Zoho takes the owner as an object with
    // a user id; a bare name or email is rejected. Dropped if Zoho refuses it
    // — an unassigned lead is still a lead, a rejected one is not.
    const owner = formConfig.show.leadOwner;
    if (owner && owner.id) record.Owner = { id: String(owner.id) };

    // Consent is optional — somebody who will not opt in to marketing is
    // still a lead worth having, and answering their enquiry is allowed
    // without it. But the CRM has to KNOW, or they end up on a mailshot by
    // accident. Email_Opt_Out is Zoho's own flag for exactly this and it
    // stops mass email at source, rather than relying on anyone reading a note.
    if (consent === false) record.Email_Opt_Out = true;

    if (withDetail) {
        // Fallback path: no notes scope, so nothing may be dropped here.
        const extras = answers.filter(a => !a.standard).map(a => `${a.label}: ${a.value}`);
        if (lead.fields._boothRating) extras.unshift(`Follow-up: ${lead.fields._boothRating}`);
        record.Description = [
            `Captured at ${formConfig.show.name} — ${stamp(lead.submittedAt, formConfig.show.timeZone)}`,
            ...extras,
            consent === null ? null : consent
                ? 'Marketing consent: GIVEN'
                : 'Marketing consent: NOT GIVEN — reply to this enquiry only, no mailouts',
        ].filter(Boolean).join('\n');
    } else {
        // The capture stamp stays here even though Zoho records a Created_Time:
        // an offline lead is created when the wifi returns, so Zoho's clock can
        // be hours off from when this person actually stood at the booth.
        record.Description = `Captured at the ${formConfig.show.name} — ${stamp(lead.submittedAt, formConfig.show.timeZone)}. Full details in Notes.`;
    }
    return record;
}

/**
 * The booth conversation as a Zoho Note, laid out to be read at a glance.
 *
 * Zoho renders note content as plain text with line breaks intact, so the
 * layout is spacing and headings rather than markup. Labels are padded into
 * a column because the follow-up crew scans these, they do not read them.
 */
function buildNote(lead, formConfig) {
    const { answers, consent } = collectAnswers(lead, formConfig);
    const show = formConfig.show;
    const when = stamp(lead.submittedAt, show.timeZone);

    const contactIds = new Set(['First_Name', 'Last_Name', 'Phone', 'Email', 'City']);
    const contact = answers.filter(a => a.standard);
    const project = answers.filter(a => !a.standard && a.label !== (formConfig.fields.find(f => f.type === 'textarea')?.crmLabel || 'Notes'));
    const freeText = answers.find(a => a.label === (formConfig.fields.find(f => f.type === 'textarea')?.crmLabel || 'Notes'));

    // Pad labels to a column, but only within a section — a global width
    // would leave one long label stretching all the others.
    const block = (rows) => {
        const w = Math.max(0, ...rows.map(r => r.label.length));
        return rows.map(r => `  ${r.label.padEnd(w)}   ${r.value}`).join('\n');
    };

    const lines = [];
    lines.push(`${(show.name || 'Fall Home Show 2026').toUpperCase()} — PROJECT ENQUIRY`);
    lines.push(when);

    if (lead.fields._boothRating) {
        lines.push('', 'ENQUIRY PRIORITY', `  ${lead.fields._boothRating}`);
    }
    if (contact.length) lines.push('', 'CONTACT DETAILS', block(contact));
    if (project.length) lines.push('', 'PROJECT REQUIREMENTS', block(project));
    if (freeText) lines.push('', 'ADDITIONAL DETAILS', `  ${freeText.value}`);

    // Inspiration comes from Ironwood's own gallery, so the note points at
    // the attachments rather than repeating image ids nobody can read.
    const inspo = lead.fields._inspiration || [];
    if (inspo.length) {
        lines.push('', 'INSPIRATION CHOSEN',
            `  ${inspo.length} photograph${inspo.length === 1 ? '' : 's'} picked from the Ironwood gallery,`,
            `  attached to this lead as "Inspiration 1"${inspo.length > 1 ? `–"Inspiration ${inspo.length}"` : ''}.`);
    }
    if (consent !== null) {
        // Record the wording they actually agreed to, not just that they did.
        // Proving express consent means being able to show WHAT was consented
        // to and when — a bare "consent: yes" is not evidence of anything.
        const statement = (formConfig.fields.find(f => f.type === 'consent') || {}).label || '';
        lines.push('', 'CONSENT', consent
            ? `  Marketing consent GIVEN ${when}.${statement ? `\n  Agreed to: "${statement}"` : ''}`
            : '  Marketing consent NOT given.\n'
              + '  Reply to THIS enquiry as normal — they asked us to.\n'
              + '  Do NOT add them to mailouts or campaigns. Email Opt Out is\n'
              + '  set on this lead.');
    }
    lines.push('', '—', `Recorded at the ${show.name} via the Ironwood intake application.`);

    return {
        Note_Title: `Project enquiry — ${show.name}`,
        Note_Content: lines.join('\n'),
    };
}

// Fields we ADD for filing purposes rather than fields the visitor gave us.
// Each is a picklist, and Zoho rejects a value that is not already in the
// picklist — so a tidy-filing preference must never cost a real lead.
const DROPPABLE_PICKLISTS = new Set(['Lead_Status', 'Lead_Source', 'Owner']);

/** Push one lead. Returns { leadId } or throws with .permanent for 4xx data errors. */
async function createLead(cfg, record, { _retried = false } = {}) {
    const token = await accessToken(cfg);
    const res = await fetch(`${apiBase(cfg.datacenter)}/Leads`, {
        method: 'POST',
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
        },
        // trigger:["workflow"] so their CRM's assignment rules and
        // notifications fire exactly as if the lead was typed in by hand.
        body: JSON.stringify({ data: [record], trigger: ['workflow'] }),
    });
    const body = await res.json().catch(() => ({}));
    const result = body.data?.[0];

    if (res.ok && result?.status === 'success') {
        return { leadId: result.details?.id || '' };
    }

    // A picklist value this org has not defined ("Home Show" is not in their
    // Lead Status list, say) would otherwise reject the whole lead. Drop the
    // offending field and send it again: a lead filed under the wrong status
    // is recoverable, a lead that never arrived is not.
    const badField = result?.details?.api_name;
    if (!_retried && result?.code === 'INVALID_DATA' && DROPPABLE_PICKLISTS.has(badField) && badField in record) {
        const { [badField]: dropped, ...rest } = record;
        const out = await createLead(cfg, rest, { _retried: true });
        out.droppedField = { field: badField, value: dropped };
        return out;
    }

    const code = result?.code || body.code || `HTTP ${res.status}`;
    const message = result?.message || body.message || 'Zoho rejected the lead';
    const err = new Error(`${code}: ${message}`);
    // Data errors won't fix themselves on retry; auth/network errors might.
    err.permanent = ['INVALID_DATA', 'MANDATORY_NOT_FOUND', 'DUPLICATE_DATA'].includes(result?.code);
    throw err;
}

/**
 * Attach a Note to an existing Lead.
 *
 * Separate from createLead on purpose: if the note fails, the lead is
 * already safe in the CRM, and the retry path can post ONLY the missing
 * note rather than creating a duplicate lead.
 */
async function createNote(cfg, leadId, note) {
    const token = await accessToken(cfg);
    // The top-level /Notes module, NOT /Leads/{id}/Notes — the related-list
    // route 401s with OAUTH_SCOPE_MISMATCH even holding notes.CREATE, which
    // reads exactly like a bad token and is not one. Parent_Id must be an
    // object, and its `module` must be an object too: a bare string is
    // rejected as INVALID_DATA. All three verified against live CRM.
    const res = await fetch(`${apiBase(cfg.datacenter)}/Notes`, {
        method: 'POST',
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            data: [{
                ...note,
                Parent_Id: { id: leadId, module: { api_name: 'Leads' } },
                se_module: 'Leads',
            }],
        }),
    });
    const body = await res.json().catch(() => ({}));
    const result = body.data?.[0];
    if (res.ok && result?.status === 'success') {
        return { noteId: result.details?.id || '' };
    }
    const code = result?.code || body.code || `HTTP ${res.status}`;
    const message = result?.message || body.message || 'Zoho rejected the note';
    const err = new Error(`${code}: ${message}`);
    // OAUTH_SCOPE_MISMATCH means the token was generated without
    // notes.CREATE — retrying cannot fix it, only reconnecting can.
    err.scopeProblem = /OAUTH_SCOPE_MISMATCH|INVALID_TOKEN/i.test(String(code));
    throw err;
}

/**
 * Attach one photograph to an existing Lead.
 *
 * Zoho takes attachments as multipart/form-data with the field named "file";
 * Node's built-in FormData/Blob build that without a dependency.
 */
async function createAttachment(cfg, leadId, { buffer, filename, mimeType }) {
    // Refuse to upload something that is not an image. A truncated download or
    // an error page served with a 200 would otherwise land in the CRM as a
    // file that exists and will not open — which is worse than a clear failure,
    // because nobody notices until they go looking for the photograph.
    if (!buffer || buffer.length < 1024) {
        const err = new Error(`Refusing to attach ${buffer ? buffer.length : 0} bytes as "${filename}"`);
        err.permanent = true;
        throw err;
    }
    const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isWebp = buffer.slice(8, 12).toString('ascii') === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) {
        const err = new Error(`"${filename}" is not image data (starts ${buffer.slice(0, 4).toString('hex')})`);
        err.permanent = true;
        throw err;
    }

    const token = await accessToken(cfg);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'image/jpeg' }), safeFilename(filename));

    const res = await fetch(`${apiBase(cfg.datacenter)}/Leads/${encodeURIComponent(leadId)}/Attachments`, {
        method: 'POST',
        // No Content-Type header: fetch must set it, because it alone knows
        // the multipart boundary it generated.
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        body: form,
    });
    const body = await res.json().catch(() => ({}));
    const result = body.data?.[0];
    if (res.ok && result?.status === 'success') {
        return { attachmentId: result.details?.id || '' };
    }
    const code = result?.code || body.code || `HTTP ${res.status}`;
    const message = result?.message || body.message || 'Zoho rejected the attachment';
    const err = new Error(`${code}: ${message}`);
    err.scopeProblem = /OAUTH_SCOPE_MISMATCH|INVALID_TOKEN/i.test(String(code));
    throw err;
}

/**
 * Prove what a token can actually do, without writing anything.
 *
 * The stored scope string is only a claim, and an env-var connection has no
 * scope string at all — so the app cannot otherwise tell a good token from a
 * stale one until a real customer's photograph is refused mid-show. A read
 * succeeds only with leads.ALL (leads.CREATE cannot read), which is exactly
 * the permission attachments need, so one harmless GET settles it.
 */
async function verifyConnection(cfg) {
    const out = { auth: false, canReadLeads: false, detail: '' };
    let token;
    try {
        token = await accessToken(cfg);
        out.auth = true;
    } catch (err) {
        out.detail = err.message;
        return out;
    }
    try {
        const res = await fetch(`${apiBase(cfg.datacenter)}/Leads?fields=Last_Name&per_page=1`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
        if (res.ok || res.status === 204) {
            out.canReadLeads = true;
            out.detail = 'Token has full Leads access — photographs will attach.';
        } else {
            const body = await res.json().catch(() => ({}));
            out.detail = /OAUTH_SCOPE_MISMATCH/i.test(JSON.stringify(body))
                ? 'Token is missing full Leads access (leads.ALL). Photographs will be refused — reconnect, or update ZOHO_REFRESH_TOKEN if this is a hosted copy.'
                : (body.message || `Zoho returned ${res.status}`);
        }
    } catch (err) {
        out.detail = err.message;
    }
    return out;
}

/**
 * A short note recording what may be done with the photographs.
 *
 * Filed separately from the intake note because it arrives later and because
 * it answers a different question: not "what does this customer want" but
 * "may we put this on Instagram". Somebody choosing a photo for a post needs
 * that answer next to the photo, not in a spreadsheet.
 */
function buildPhotoPermissionNote({ count, mayShare, statement, at, showName }) {
    const lines = [
        `${count} photograph${count === 1 ? '' : 's'} received from the customer's phone.`,
        '',
        mayShare ? 'PUBLIC SHARING: PERMITTED' : 'PUBLIC SHARING: NOT PERMITTED',
        mayShare
            ? '  The customer agreed to their project being shown in the work\n'
              + '  portfolio — before-and-after posts, the website, printed work\n'
              + '  samples. Show the WORK only: no name, no address, nothing that\n'
              + '  identifies their home.'
            : '  Use for estimating only. These photographs must NOT be published\n'
              + '  or used in advertising.',
    ];
    if (mayShare && statement) lines.push('', `  Agreed to: "${statement}"`);
    if (at) lines.push('', `  Recorded ${at}.`);
    return {
        Note_Title: `Photographs — ${mayShare ? 'sharing permitted' : 'estimating use only'}`,
        Note_Content: lines.join('\n'),
    };
}

/**
 * A filename safe to hand Zoho.
 *
 * Spaces and punctuation in an attachment name are legal in multipart but
 * survive into the stored file, and anything downstream that builds a URL
 * from that name can break on them. Hyphens cost nothing and cannot.
 */
function safeFilename(name) {
    const fallback = 'photo.jpg';
    if (!name) return fallback;
    const m = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(String(name).trim());
    const stem = (m[1] || 'photo')
        .replace(/[^\w.-]+/g, '-')   // spaces and punctuation out
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
    return (stem || 'photo') + (m[2] || '.jpg').toLowerCase();
}

/**
 * Every lead id this CRM holds for a given source.
 *
 * Used to prove the day's capture actually arrived. "The app says it synced"
 * is the app marking its own homework; this asks Zoho.
 */
async function listLeadIdsBySource(cfg, source, { maxPages = 20 } = {}) {
    const token = await accessToken(cfg);
    const ids = new Set();
    for (let page = 1; page <= maxPages; page++) {
        const res = await fetch(
            `${apiBase(cfg.datacenter)}/Leads?fields=id,Lead_Source&per_page=200&page=${page}`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
        if (res.status === 204) break;
        if (!res.ok) throw new Error(`Zoho returned ${res.status} listing leads`);
        const body = await res.json();
        for (const l of (body.data || [])) {
            if (!source || l.Lead_Source === source) ids.add(l.id);
        }
        if (!body.info?.more_records) break;
        // Ran out of pages with records still to come: the audit would
        // otherwise report perfectly good leads as missing from the CRM,
        // which is worse than not answering.
        if (page === maxPages) {
            const err = new Error('Too many leads to check in one pass — the result would be misleading.');
            err.truncated = true;
            throw err;
        }
    }
    return ids;
}

/** Does this connection's token allow uploading attachments? */
function canWriteAttachments(cfg) {
    if (!cfg || !cfg.grantedScopes) return true; // env-var connection: unknowable, so try
    return cfg.grantedScopes.split(/[\s,]+/)
        .some(s => /^zohocrm\.modules\.(attachments|all)\./i.test(s));
}

module.exports = {
    REQUIRED_SCOPE, LEAD_SCOPE, NOTE_SCOPE, ATTACHMENT_SCOPE, DATACENTERS,
    createAttachment, canWriteAttachments, verifyConnection, buildPhotoPermissionNote, safeFilename, listLeadIdsBySource,
    normalizeDatacenter, apiBase, canWriteNotes,
    exchangeCode, accessToken, buildLeadRecord, buildNote, createLead, createNote,
    _resetTokenCache: () => { cached = { token: null, expiresAt: 0, key: '' }; },
};
