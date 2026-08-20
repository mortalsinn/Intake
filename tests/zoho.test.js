const test = require('node:test');
const assert = require('node:assert');
const { buildLeadRecord, normalizeDatacenter, apiBase } = require('../lib/zoho');

const formConfig = {
    show: { name: 'Renovation Home Show', leadSource: 'Home Show' },
    companyFallback: 'Homeowner',
    fields: [
        { id: 'firstName', label: 'First name', type: 'text', zoho: 'First_Name' },
        { id: 'lastName', label: 'Last name', type: 'text', zoho: 'Last_Name' },
        { id: 'phone', label: 'Phone', type: 'tel', zoho: 'Phone' },
        { id: 'email', label: 'Email', type: 'email', zoho: 'Email' },
        { id: 'city', label: 'City', type: 'text', zoho: 'City' },
        { id: 'interests', label: 'Interested in', type: 'multi', options: ['A', 'B'] },
        { id: 'timeline', label: 'Timeline', type: 'choice', options: ['ASAP'] },
        { id: 'notes', label: 'Notes', type: 'textarea' },
        { id: 'consent', label: 'OK to contact', type: 'consent' },
    ],
};

const lead = (fields) => ({ id: 'x', submittedAt: '2026-08-20T10:00:00Z', fields });

test('maps standard fields onto Zoho Lead fields', () => {
    const r = buildLeadRecord(lead({
        firstName: 'Pat', lastName: 'Woo', phone: '403-555-0100',
        email: 'pat@example.com', city: 'Calgary',
    }), formConfig);
    assert.equal(r.First_Name, 'Pat');
    assert.equal(r.Last_Name, 'Woo');
    assert.equal(r.Phone, '403-555-0100');
    assert.equal(r.Email, 'pat@example.com');
    assert.equal(r.City, 'Calgary');
    assert.equal(r.Lead_Source, 'Home Show');
    assert.equal(r.Company, 'Homeowner');
});

test('non-Zoho fields land in Description, not dropped', () => {
    const r = buildLeadRecord(lead({
        lastName: 'Woo',
        phone: '1',
        interests: ['Interior railing', 'Stairs'],
        timeline: '1–3 months',
        notes: 'oak to iron',
        consent: true,
    }), formConfig);
    assert.match(r.Description, /Interior railing, Stairs/);
    assert.match(r.Description, /1–3 months/);
    assert.match(r.Description, /oak to iron/);
    assert.match(r.Description, /Consent: agreed/);
    assert.match(r.Description, /Renovation Home Show/);
});

test('consent=false is recorded as NOT given', () => {
    const r = buildLeadRecord(lead({ lastName: 'W', phone: '1', consent: false }), formConfig);
    assert.match(r.Description, /Consent: NOT given/);
});

test('never builds a record Zoho must refuse: Last_Name and Company always set', () => {
    const r = buildLeadRecord(lead({ firstName: 'Sam', phone: '1' }), formConfig);
    assert.equal(r.Last_Name, 'Sam');
    const r2 = buildLeadRecord(lead({ phone: '1' }), formConfig);
    assert.equal(r2.Last_Name, 'Unknown (home show)');
    assert.equal(r2.Company, 'Homeowner');
});

test('datacenter normalizes and points at zohoapis, not accounts', () => {
    assert.equal(normalizeDatacenter('ca'), 'ca');
    assert.equal(normalizeDatacenter('nope'), 'com');
    assert.equal(apiBase('ca'), 'https://www.zohoapis.ca/crm/v7');
});
