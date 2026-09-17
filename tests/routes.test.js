// ========================================================
// Filename: tests/routes.test.js
// Description: The HTTP surface, end to end, in demo mode.
//
// Every other test file exercises a library on its own. These
// drive the actual Express app the iPad talks to — the same
// routes, the same validation, the same store — with DEMO_MODE
// on so nothing can reach a CRM, and a throwaway DATA_DIR so
// nothing touches real captures.
// ========================================================
process.env.DEMO_MODE = '1';
process.env.ADMIN_PIN = '000000';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-routes-'));

const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../server');

let server, base;
test.before(() => new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
    });
}));
test.after(() => server.close());

const PIN = { 'x-admin-pin': '000000' };
const json = (path, body, headers = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
});

const lead = (kind, id, extra = {}) => ({
    id, kind, submittedAt: new Date().toISOString(),
    fields: {
        firstName: 'Dana', lastName: 'Woo', phone: '(403) 555-0188', email: 'd@e.com',
        city: 'Calgary', contactPref: ['Email'], role: 'Renovator', ...extra,
    },
});

test('brands and every advertised form are served', async () => {
    const brands = await (await json('/api/brands')).json();
    assert.ok(brands.brands.length >= 2);
    for (const b of brands.brands) for (const cta of b.ctas) {
        const res = await json(`/api/form?kind=${cta.kind}`);
        assert.equal(res.status, 200, `${b.id}/${cta.kind}`);
        const cfg = await res.json();
        assert.ok(Array.isArray(cfg.fields) && cfg.fields.length, `${cta.kind} has fields`);
    }
});

test('an Ironwood enquiry gets an upload link; a Code Compass demo request does not', async () => {
    const a = await (await json('/api/leads', lead('enquiry', 'r-iw-1'))).json();
    assert.equal(a.ok, true);
    assert.match(a.uploadUrl, /\/u\/[A-Za-z0-9_-]+$/, 'Ironwood leads are asked for photographs');

    const b = await (await json('/api/leads', lead('ribit', 'r-rb-1'))).json();
    assert.equal(b.ok, true);
    assert.equal(b.uploadUrl, null, 'a demo request must not be asked for project photographs');
});

test('the same submission arriving twice is stored once', async () => {
    const first = await (await json('/api/leads', lead('enquiry', 'r-dup'))).json();
    const again = await (await json('/api/leads', lead('enquiry', 'r-dup'))).json();
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.uploadUrl, first.uploadUrl, 'the retry gets the SAME link, not a second one');
});

test('the server rejects only the unusable, never the merely incomplete', async () => {
    const bare = await json('/api/leads', { id: 'r-bare', kind: 'enquiry', fields: { firstName: 'A', lastName: 'B', phone: '4035550000', email: 'a@b.c', city: 'X', contactPref: ['Email'] } });
    assert.equal(bare.status, 200, 'required fields only is a lead');
    const empty = await json('/api/leads', { id: 'r-empty', kind: 'enquiry', fields: {} });
    assert.equal(empty.status, 400);
    const noId = await json('/api/leads', { kind: 'enquiry', fields: { firstName: 'A' } });
    assert.equal(noId.status, 400);
});

test('an unknown kind falls back to the enquiry form rather than crashing', async () => {
    const res = await json('/api/leads', lead('nonsense', 'r-kind'));
    assert.equal(res.status, 200);
    const status = await (await json('/api/admin/status', undefined, PIN)).json();
    assert.equal(status.leads.find(l => l.id === 'r-kind').kind, 'enquiry');
});

test('demo mode: leads stay pending, admin says so, nothing claims to have synced', async () => {
    const s = await (await json('/api/admin/status', undefined, PIN)).json();
    assert.equal(s.demoMode, true);
    assert.equal(s.zoho.connected, false);
    assert.equal(s.counts.synced, 0);
    assert.ok(s.counts.byKind.ribit.total >= 1);
    assert.ok(s.counts.byKind.enquiry.total >= 1);
});

test('the audit runs — and no longer dies on an undefined variable', async () => {
    // Regression: the multi-brand change renamed `source` to `sources` in
    // one place and not the other. The one button that proves nothing was
    // lost reported "source is not defined" on every press.
    const a = await (await json('/api/admin/audit', undefined, PIN)).json();
    assert.equal(a.ok, true);
    assert.equal(a.journal.missingFromWorkingSet.length, 0);
    assert.equal(a.zoho.checked, false, 'demo mode: no CRM to check');
    assert.equal(a.zoho.error, undefined);
});

test('each kind exports its own CSV with its own columns', async () => {
    const iw = await (await json('/api/admin/export.csv?kind=enquiry', undefined, PIN)).text();
    const rb = await (await json('/api/admin/export.csv?kind=ribit', undefined, PIN)).text();
    assert.match(iw.split('\r\n')[0], /"interests"/);
    assert.match(rb.split('\r\n')[0], /"jurisdictions"/);
    assert.ok(iw.includes('r-iw-1') || iw.includes('Woo'), 'Ironwood rows in the Ironwood file');
    assert.ok(!rb.includes('r-dup'), 'no Ironwood rows in the Ribit file');
});

test('the priority tap lands on its lead and only its lead', async () => {
    const res = await json('/api/leads/r-iw-1/priority', { priority: 'High priority' });
    assert.equal(res.status, 200);
    const s = await (await json('/api/admin/status', undefined, PIN)).json();
    assert.equal(s.leads.find(l => l.id === 'r-iw-1').fields._boothRating, 'High priority');
    assert.equal(s.leads.find(l => l.id === 'r-rb-1').fields._boothRating, undefined);
    assert.equal((await json('/api/leads/nope/priority', { priority: 'x' })).status, 404);
});

test('the upload page names the right company for the lead', async () => {
    const a = await (await json('/api/leads', lead('enquiry', 'r-iw-1'))).json();
    const token = a.uploadUrl.split('/').pop();
    const info = await (await json(`/u/${token}/info`)).json();
    assert.equal(info.firstName, 'Dana');
    assert.match(info.company, /Ironwood/);
    assert.equal((await json('/u/not-a-token/info')).status, 404);
});

test('a wrong PIN is refused, and repeated wrong PINs lock the address out', async () => {
    assert.equal((await json('/api/admin/status', undefined, { 'x-admin-pin': '1' })).status, 401);
    let last;
    for (let i = 0; i < 6; i++) last = await json('/api/admin/status', undefined, { 'x-admin-pin': '2' });
    assert.equal(last.status, 429, 'locked out');
});
