// ========================================================
// Filename: scripts/add-lead-source.js
// Description: Add a Lead Source picklist option to Zoho.
//
// Why this exists as a script: the Zoho CRM UI has no visible
// "add option" button for this field, and Zoho SILENTLY ACCEPTS
// a Lead_Source value that is not in the picklist — it stores
// it, returns success, and then no list view filtered on source
// will ever show those leads. There is no error to catch, so
// the option must be added before a new show or brand goes live.
//
//   node scripts/add-lead-source.js "Fall Home Show 2026 - Code Compass"
//
// Needs ZohoCRM.settings.fields.ALL in the connected token.
// ========================================================
const fs = require('fs');
const path = require('path');
const zoho = require('../lib/zoho');

const NEW = process.argv[2];
if (!NEW) {
    console.error('Usage: node scripts/add-lead-source.js "<option>"');
    process.exit(1);
}

(async () => {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const cfg = process.env.ZOHO_REFRESH_TOKEN
        ? {
            clientId: process.env.ZOHO_CLIENT_ID,
            clientSecret: process.env.ZOHO_CLIENT_SECRET,
            refreshToken: process.env.ZOHO_REFRESH_TOKEN,
            datacenter: process.env.ZOHO_DC || 'com',
        }
        : JSON.parse(fs.readFileSync(path.join(dataDir, 'zoho.json'), 'utf8'));

    const token = await zoho.accessToken(cfg);
    const base = `https://www.zohoapis.${cfg.datacenter || 'com'}/crm/v7`;
    const headers = { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };

    const meta = await (await fetch(`${base}/settings/fields?module=Leads`, { headers })).json();
    const field = (meta.fields || []).find(f => f.api_name === 'Lead_Source');
    if (!field) {
        console.error('Could not read Lead_Source — the token likely lacks ZohoCRM.settings.fields.ALL.');
        process.exit(1);
    }

    const existing = field.pick_list_values || [];
    if (existing.some(o => o.display_value === NEW)) {
        console.log(`Already an option: "${NEW}" — nothing to do.`);
        return;
    }

    // Resend EVERY existing option WITH its id and exclude nothing: this is a
    // replace, not an append, so an omitted option is a DELETED option. The
    // new one goes on with no id — sending values without ids gives
    // DUPLICATE_DATA on the ones that already exist.
    const values = existing.map(o => ({
        id: o.id,
        display_value: o.display_value,
        actual_value: o.actual_value,
        sequence_number: o.sequence_number,
    }));
    values.push({ display_value: NEW, actual_value: NEW });

    const res = await fetch(`${base}/settings/fields/${field.id}?module=Leads`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: [{ id: field.id, pick_list_values: values }] }),
    });
    const body = await res.json().catch(() => ({}));
    const status = body?.fields?.[0]?.status || body?.status;
    if (!res.ok || status === 'error') {
        console.error(`FAILED (HTTP ${res.status}):`, JSON.stringify(body));
        process.exit(1);
    }
    console.log(`Added Lead Source option: "${NEW}"`);
    console.log(`Options now: ${values.length} (was ${existing.length})`);
})().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
