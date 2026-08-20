const test = require('node:test');
const assert = require('node:assert');
const { validateLead } = require('../lib/validate');

const cfg = {
    requirePhoneOrEmail: true,
    fields: [
        { id: 'lastName', label: 'Last name', type: 'text', required: true },
        { id: 'phone', label: 'Phone', type: 'tel' },
        { id: 'email', label: 'Email', type: 'email' },
        { id: 'consent', label: 'OK to contact', type: 'consent', required: true },
    ],
};

const body = (fields) => ({ id: 'abc', fields });

test('accepts a normal lead', () => {
    assert.deepEqual(validateLead(body({ lastName: 'Woo', phone: '403', consent: true }), cfg), []);
});

test('requires phone OR email — either one is enough', () => {
    assert.ok(validateLead(body({ lastName: 'W', consent: true }), cfg).length);
    assert.deepEqual(validateLead(body({ lastName: 'W', email: 'a@b.c', consent: true }), cfg), []);
});

test('consent checkbox: true passes required, false fails it', () => {
    assert.ok(validateLead(body({ lastName: 'W', phone: '1', consent: false }), cfg)
        .some(e => /OK to contact/.test(e)));
});

test('rejects garbage without throwing', () => {
    assert.ok(validateLead(null, cfg).length);
    assert.ok(validateLead({}, cfg).length);
    assert.ok(validateLead({ id: 'x'.repeat(100), fields: {} }, cfg).some(e => /id/.test(e)));
});
