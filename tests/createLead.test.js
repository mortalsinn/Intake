const test = require('node:test');
const assert = require('node:assert');
const zoho = require('../lib/zoho');

// Minimal fetch stub: each call shifts the next queued response.
function stubFetch(responses) {
    const calls = [];
    global.fetch = async (url, opts) => {
        // The token call comes first, is form-encoded, and is not part of
        // the scripted responses.
        if (String(url).includes('/oauth/v2/token')) {
            return { ok: true, json: async () => ({ access_token: 'tok' }) };
        }
        calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
        const next = responses.shift();
        return { ok: next.ok, status: next.status || 200, json: async () => next.body };
    };
    return calls;
}

const cfg = { clientId: 'c', clientSecret: 's', refreshToken: 'r', datacenter: 'com' };
const okBody = { data: [{ status: 'success', details: { id: 'LEAD1' } }] };
const rejectPicklist = (field) => ({
    ok: false,
    status: 400,
    body: { data: [{ status: 'error', code: 'INVALID_DATA', details: { api_name: field } }] },
});

test.afterEach(() => { zoho._resetTokenCache(); delete global.fetch; });

test('an undefined Lead_Status picklist value never costs the lead', async () => {
    zoho._resetTokenCache();
    const calls = stubFetch([rejectPicklist('Lead_Status'), { ok: true, body: okBody }]);
    const out = await zoho.createLead(cfg, {
        Last_Name: 'Woo', Company: 'Homeowner',
        Lead_Source: 'Home Show', Lead_Status: 'Home Show',
    });
    assert.equal(out.leadId, 'LEAD1');
    assert.deepEqual(out.droppedField, { field: 'Lead_Status', value: 'Home Show' });
    // second attempt dropped ONLY the offending field, keeping everything else
    const retried = calls.at(-1).body.data[0];
    assert.equal('Lead_Status' in retried, false);
    assert.equal(retried.Lead_Source, 'Home Show');
    assert.equal(retried.Last_Name, 'Woo');
});

test('a rejected Lead_Source is dropped the same way', async () => {
    zoho._resetTokenCache();
    stubFetch([rejectPicklist('Lead_Source'), { ok: true, body: okBody }]);
    const out = await zoho.createLead(cfg, { Last_Name: 'W', Lead_Source: 'Home Show' });
    assert.equal(out.leadId, 'LEAD1');
    assert.equal(out.droppedField.field, 'Lead_Source');
});

test('it retries once, never in a loop', async () => {
    zoho._resetTokenCache();
    stubFetch([rejectPicklist('Lead_Status'), rejectPicklist('Lead_Status')]);
    await assert.rejects(
        () => zoho.createLead(cfg, { Last_Name: 'W', Lead_Status: 'X' }),
        /INVALID_DATA/,
    );
});

test('a real data error still surfaces — only picklists are droppable', async () => {
    zoho._resetTokenCache();
    stubFetch([{
        ok: false, status: 400,
        body: { data: [{ status: 'error', code: 'INVALID_DATA', details: { api_name: 'Email' } }] },
    }]);
    await assert.rejects(
        () => zoho.createLead(cfg, { Last_Name: 'W', Email: 'nonsense' }),
        (e) => e.permanent === true,
    );
});
