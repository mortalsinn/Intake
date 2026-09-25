// ========================================================
// Filename: tests/mail.test.js
// Description: Code Compass leads go to our inbox, and only there.
// ========================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildLeadEmail, sendLeadEmail, mailConfig } = require('../lib/mail');
const { buildNote } = require('../lib/zoho');

const ribit = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'ribit-form.json'), 'utf8'));
const lead = {
    id: 'm1', kind: 'ribit', submittedAt: '2026-09-24T18:00:00.000Z',
    fields: { firstName: 'Dana', lastName: 'Woo', email: 'dana@example.com', company: 'Woo Homes', role: 'Renovator' },
};
const message = buildLeadEmail(lead, ribit, buildNote(lead, ribit).Note_Content);

test('the notification goes to info@ribitos.com and nobody else', async () => {
    let sent;
    const fetchImpl = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ id: 'e1' }) }; };
    const out = await sendLeadEmail(message, { fetchImpl, env: { RESEND_API_KEY: 'k' } });
    assert.deepStrictEqual(sent.body.to, ['info@ribitos.com']);
    assert.strictEqual(out.to, 'info@ribitos.com');
    // The visitor is Reply-To, never a recipient: we are not emailing them.
    assert.strictEqual(sent.body.reply_to, 'dana@example.com');
    assert.ok(!JSON.stringify(sent.body.to).includes('dana@example.com'));
});

test('the email carries what they told us', () => {
    assert.match(message.subject, /Dana Woo/);
    assert.match(message.subject, /Woo Homes/);
    assert.match(message.text, /Renovator/);
    assert.doesNotMatch(message.html, /<script/i);
});

test('no key: nothing is sent, and the caller is told why', async () => {
    let called = false;
    await assert.rejects(
        sendLeadEmail(message, { fetchImpl: async () => { called = true; }, env: {} }),
        (e) => e.notConfigured === true,
    );
    assert.strictEqual(called, false);
});

test('a refused key is permanent; a rate limit is not', async () => {
    const reply = (status) => async () => ({ ok: false, status, json: async () => ({ message: 'x' }) });
    await assert.rejects(sendLeadEmail(message, { fetchImpl: reply(403), env: { RESEND_API_KEY: 'k' } }), (e) => e.permanent === true);
    await assert.rejects(sendLeadEmail(message, { fetchImpl: reply(429), env: { RESEND_API_KEY: 'k' } }), (e) => e.permanent === false);
});

test('a bad key or an unverified domain is a SETUP refusal; bad data is not', async () => {
    const reply = (status) => async () => ({ ok: false, status, json: async () => ({ message: 'x' }) });
    for (const status of [401, 403]) {
        await assert.rejects(sendLeadEmail(message, { fetchImpl: reply(status), env: { RESEND_API_KEY: 'k' } }), (e) => e.setup === true);
    }
    await assert.rejects(sendLeadEmail(message, { fetchImpl: reply(422), env: { RESEND_API_KEY: 'k' } }), (e) => e.setup === false);
    await assert.rejects(sendLeadEmail(message, { fetchImpl: reply(429), env: { RESEND_API_KEY: 'k' } }), (e) => e.setup === false);
});

test('the default recipient is info@ribitos.com', () => {
    assert.strictEqual(mailConfig({}).to, 'info@ribitos.com');
});
