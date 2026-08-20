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

// The one scope this app needs. Shown verbatim on the admin screen so the
// self-client is generated with exactly it — a wrong scope string is the
// most common way a Zoho connection comes back green and then can't write.
const REQUIRED_SCOPE = 'ZohoCRM.modules.leads.CREATE';

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

/**
 * Shape one stored lead into a Zoho CRM Lead record. Pure, so it's testable.
 *
 * Fields with a "zoho" key in form.json map straight onto standard Lead
 * fields. Everything else (interests, timeline, notes, consent) is carried
 * in Description — same principle as the AscendOS quote push: a lead that
 * reads a bit long beats one that silently loses half the conversation.
 */
function buildLeadRecord(lead, formConfig) {
    const record = {};
    const extras = [];

    for (const field of formConfig.fields) {
        const value = lead.fields[field.id];
        const has = Array.isArray(value) ? value.length > 0 : value != null && String(value).trim() !== '';
        if (field.zoho) {
            if (has) record[field.zoho] = String(value).trim();
        } else if (field.type === 'consent') {
            extras.push(has && value === true
                ? `Consent: agreed to be contacted (${lead.submittedAt})`
                : 'Consent: NOT given');
        } else if (has) {
            extras.push(`${field.label}: ${Array.isArray(value) ? value.join(', ') : String(value).trim()}`);
        }
    }

    // Booth rating comes from the staff strip on the thank-you screen, not
    // from a form field, so it isn't in formConfig.fields. Lead with it —
    // it's the first thing the person doing follow-up wants to know.
    if (lead.fields._boothRating) {
        extras.unshift(`Booth assessment: ${lead.fields._boothRating}`);
    }

    // Zoho refuses a Lead without Last_Name, and many orgs mark Company
    // mandatory too. Neither is a reason to drop a captured lead.
    if (!record.Last_Name) record.Last_Name = record.First_Name || 'Unknown (home show)';
    record.Company = record.Company || formConfig.companyFallback || 'Homeowner';
    record.Lead_Source = formConfig.show.leadSource || 'Home Show';
    record.Description = [
        `Captured at ${formConfig.show.name} — ${lead.submittedAt}`,
        ...extras,
    ].join('\n');

    return record;
}

/** Push one lead. Returns { leadId } or throws with .permanent for 4xx data errors. */
async function createLead(cfg, record) {
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

    const code = result?.code || body.code || `HTTP ${res.status}`;
    const message = result?.message || body.message || 'Zoho rejected the lead';
    const err = new Error(`${code}: ${message}`);
    // Data errors won't fix themselves on retry; auth/network errors might.
    err.permanent = ['INVALID_DATA', 'MANDATORY_NOT_FOUND', 'DUPLICATE_DATA'].includes(result?.code);
    throw err;
}

module.exports = {
    REQUIRED_SCOPE, DATACENTERS,
    normalizeDatacenter, apiBase,
    exchangeCode, accessToken, buildLeadRecord, createLead,
    _resetTokenCache: () => { cached = { token: null, expiresAt: 0, key: '' }; },
};
