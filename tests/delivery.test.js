// ========================================================
// Filename: tests/delivery.test.js
// Description: Where each lead actually goes, end to end.
//
// Drives the real Express app and the real pushers with only
// the outside world stubbed: Zoho's API and Resend's. Every
// request the app makes is recorded, so these tests assert on
// what would have reached the CRM and the inbox — not on what
// the app believes it did.
// ========================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-delivery-'));
process.env.ADMIN_PIN = '000000';
process.env.ZOHO_CLIENT_ID = 'cid';
process.env.ZOHO_CLIENT_SECRET = 'sec';
process.env.ZOHO_REFRESH_TOKEN = 'ref';
process.env.ZOHO_DC = 'com';
process.env.RESEND_API_KEY = 'rk';
delete process.env.DEMO_MODE;
delete process.env.LEAD_EMAIL_TO;

const test = require('node:test');
const assert = require('node:assert');

const realFetch = globalThis.fetch;
const calls = [];
let tagFailures = 0;
let nextLead = 1000;
// Set to a Resend error body to have every send refused with 403.
let resendRefusal = null;
const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    const body = opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: u, method: opts.method || 'GET', body });
    if (u.includes('accounts.zoho.com/oauth')) return reply({ access_token: 'tok' });
    if (u.endsWith('/crm/v7/Leads') && opts.method === 'POST') return reply({ data: [{ status: 'success', details: { id: String(nextLead++) } }] });
    if (u.endsWith('/crm/v7/Notes')) return reply({ data: [{ status: 'success', details: { id: 'n1' } }] });
    if (u.includes('/Leads/actions/add_tags')) {
        if (tagFailures > 0) { tagFailures--; return reply({ data: [{ status: 'error', code: 'INVALID_DATA', message: 'nope' }] }); }
        return reply({ data: [{ status: 'success', details: {} }] });
    }
    if (u.startsWith('https://api.resend.com')) {
        return resendRefusal ? reply(resendRefusal, 403) : reply({ id: 'em1' });
    }
    throw new Error(`unexpected outbound request: ${u}`);
};

const { app } = require('../server');
let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const post = (p, b) => realFetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pin': '000000' }, body: JSON.stringify(b ?? {}) });
const status = async () => (await realFetch(base + '/api/admin/status', { headers: { 'x-admin-pin': '000000' } })).json();
const leadOf = async (id) => (await status()).leads.find(l => l.id === id);
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const of = (pred) => calls.filter(pred);

const visitor = (id, kind, extra = {}) => ({
    id, kind, submittedAt: new Date().toISOString(),
    fields: { firstName: 'Dana', lastName: `Woo-${id}`, phone: '(403) 555-0188', email: `${id}@example.com`, city: 'Calgary', contactPref: ['Email'], role: 'Renovator', ...extra },
});

test('an Ironwood lead is held for the priority tap, then filed with it: Contact in Future, tagged, owned', async () => {
    await post('/api/leads', visitor('iw1', 'enquiry'));
    const { pushPending } = require('../server');
    await pushPending();
    assert.strictEqual(of(c => c.url.endsWith('/Leads') && c.method === 'POST').length, 0,
        'must NOT be sent before staff have had the chance to rate it');

    await post('/api/leads/iw1/priority', { priority: 'High priority' });
    assert.ok(await until(async () => (await leadOf('iw1')).zoho.tagsDone), 'lead, note and tag all land');

    const created = of(c => c.url.endsWith('/Leads') && c.method === 'POST')[0].body.data[0];
    assert.strictEqual(created.Lead_Status, 'Contact in Future');
    assert.strictEqual(created.Lead_Source, 'Fall Home Show 2026');
    assert.strictEqual(created.Owner.id, '4797857000028057001', 'Camille');
    const note = of(c => c.url.endsWith('/Notes'))[0].body.data[0].Note_Content;
    assert.match(note, /High priority/, 'the priority reaches the CRM note');
    const tag = of(c => c.url.includes('add_tags'))[0].body;
    assert.deepStrictEqual(tag.tags, [{ name: 'Fall Home Show 2026' }]);
    assert.strictEqual(of(c => c.url.startsWith('https://api.resend.com')).length, 0, 'Ironwood is never emailed');
});

test('a failed tag is retried on its own — the note is not posted twice', async () => {
    tagFailures = 1;
    const notesBefore = of(c => c.url.endsWith('/Notes')).length;
    await post('/api/leads', visitor('iw2', 'enquiry'));
    await post('/api/leads/iw2/release');
    assert.ok(await until(async () => (await leadOf('iw2')).zoho.tagError), 'the tag failure is recorded');
    assert.strictEqual((await leadOf('iw2')).zoho.status, 'synced', 'the lead itself is safe in the CRM');

    await post('/api/admin/retry', { id: 'iw2' });
    assert.ok(await until(async () => (await leadOf('iw2')).zoho.tagsDone), 'retry applies the tag');
    assert.strictEqual(of(c => c.url.endsWith('/Notes')).length - notesBefore, 1, 'exactly one note, not two');
    assert.strictEqual(of(c => c.url.endsWith('/Leads') && c.method === 'POST' && c.body.data[0].Last_Name === 'Woo-iw2').length, 1, 'exactly one lead, not two');
});

test('a Code Compass lead is emailed to info@ribitos.com — and never touches the CRM', async () => {
    const leadCallsBefore = of(c => c.url.includes('zohoapis')).length;
    await post('/api/leads', visitor('cc1', 'ribit', { company: 'Woo Homes' }));
    assert.strictEqual((await leadOf('cc1')).zoho.status, 'local', 'marked not-for-CRM at capture');

    await post('/api/leads/cc1/priority', { priority: 'Standard priority' });
    assert.ok(await until(async () => (await leadOf('cc1')).mail?.status === 'sent'), 'emailed');

    const sent = of(c => c.url.startsWith('https://api.resend.com'));
    assert.strictEqual(sent.length, 1, 'exactly one email');
    assert.deepStrictEqual(sent[0].body.to, ['info@ribitos.com']);
    assert.strictEqual(sent[0].body.reply_to, 'cc1@example.com');
    assert.match(sent[0].body.subject, /Woo-cc1/);
    assert.match(sent[0].body.text, /Standard priority/, 'the priority reaches the email');
    assert.strictEqual(of(c => c.url.includes('zohoapis')).length, leadCallsBefore, 'ZERO requests to the CRM');
});

test('skipping the priority releases the lead straight away, unrated', async () => {
    await post('/api/leads', visitor('cc2', 'ribit'));
    const res = await post('/api/leads/cc2/release');
    assert.strictEqual(res.status, 200);
    assert.ok(await until(async () => (await leadOf('cc2')).mail?.status === 'sent'));
    assert.strictEqual((await post('/api/leads/nope/release')).status, 404);
});

test('refused for an unverified domain: held, shown in Resend\'s words, and sent the moment a test email proves it fixed', async () => {
    resendRefusal = { statusCode: 403, name: 'validation_error', message: 'The ribitos.com domain is not verified. Please, add and verify your domain on https://resend.com/domains' };
    await post('/api/leads', visitor('cc3', 'ribit'));
    await post('/api/leads/cc3/release');
    assert.ok(await until(async () => (await leadOf('cc3')).mail?.status === 'failed'), 'refused');
    const s1 = await status();
    assert.match(s1.mail.lastError, /domain is not verified/, 'the admin page is told WHY, not just that');
    assert.strictEqual((await leadOf('cc3')).mail.setup, true, 'a setup refusal, not a bad lead');

    // Still refused: the test says so, word for word, and nothing moves.
    const t1 = await (await post('/api/admin/mail/test')).json();
    assert.strictEqual(t1.ok, false);
    assert.match(t1.error, /domain is not verified/);
    assert.strictEqual(t1.from, 'RibitOS Home Show <info@ribitos.com>');

    // The domain is verified in Resend. One test email, and the held lead goes.
    resendRefusal = null;
    const t2 = await (await post('/api/admin/mail/test')).json();
    assert.strictEqual(t2.ok, true);
    assert.strictEqual(t2.requeued, 1);
    assert.ok(await until(async () => (await leadOf('cc3')).mail?.status === 'sent'), 'sent without anybody pressing Retry');
    assert.strictEqual((await leadOf('cc3')).mail.setup, undefined);
    const test = of(c => c.url.startsWith('https://api.resend.com') && /test email/.test(c.body.subject));
    assert.deepStrictEqual(test.at(-1).body.to, ['info@ribitos.com'], 'the test goes where the leads go');
});
