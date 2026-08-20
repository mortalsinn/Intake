const test = require('node:test');
const assert = require('node:assert');
const { buildLeadRecord, buildNote, canWriteNotes, normalizeDatacenter, apiBase } = require('../lib/zoho');

const formConfig = {
    show: { name: 'Fall Home Show 2026', leadSource: 'Fall Home Show 2026', timeZone: 'America/Edmonton' },
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
    assert.equal(r.Lead_Source, 'Fall Home Show 2026');
    assert.equal(r.Company, 'Homeowner');
});

test('Description keeps the capture line and points at the Notes', () => {
    const r = buildLeadRecord(lead({ lastName: 'Woo', phone: '1', notes: 'oak to iron' }), formConfig);
    assert.match(r.Description, /^Captured at the Fall Home Show 2026/);
    assert.match(r.Description, /Full details in Notes\./);
    // the detail belongs in the note now, not smuggled into the description
    assert.doesNotMatch(r.Description, /oak to iron/);
});

test('the note carries every answer, in labelled sections', () => {
    const note = buildNote(lead({
        firstName: 'Dana', lastName: 'Woo', phone: '(403) 555-0188', email: 'd@e.com', city: 'Cochrane',
        interests: ['Interior railing', 'Mirrors'],
        timeline: '1–3 months',
        notes: 'oak to iron, has photos',
        consent: true,
        _boothRating: 'HOT LEAD',
    }), formConfig);
    assert.match(note.Note_Title, /Project enquiry/);
    const c = note.Note_Content;
    assert.match(c, /ENQUIRY PRIORITY/);
    assert.match(c, /HOT LEAD/);
    assert.match(c, /CONTACT DETAILS/);
    assert.match(c, /\(403\) 555-0188/);
    assert.match(c, /PROJECT REQUIREMENTS/);
    assert.match(c, /Interior railing, Mirrors/);
    assert.match(c, /ADDITIONAL DETAILS/);
    assert.match(c, /oak to iron, has photos/);
    assert.match(c, /CONSENT/);
    assert.match(c, /Consent given for contact/);
});

test('note omits sections that have no answers — no empty headings', () => {
    const note = buildNote(lead({ lastName: 'Woo', phone: '1' }), formConfig);
    assert.doesNotMatch(note.Note_Content, /ENQUIRY PRIORITY/);
    assert.doesNotMatch(note.Note_Content, /PROJECT REQUIREMENTS/);
    assert.doesNotMatch(note.Note_Content, /ADDITIONAL DETAILS/);
});

test('refused consent is stated loudly in the note', () => {
    const note = buildNote(lead({ lastName: 'W', phone: '1', consent: false }), formConfig);
    assert.match(note.Note_Content, /CONSENT NOT GIVEN — do not contact/);
});

test('withDetail is the no-notes-scope fallback: nothing is dropped', () => {
    const r = buildLeadRecord(lead({
        lastName: 'W', phone: '1', notes: 'oak to iron', timeline: '1–3 months', _boothRating: 'HOT LEAD',
    }), formConfig, { withDetail: true });
    assert.match(r.Description, /Follow-up: HOT LEAD/);
    assert.match(r.Description, /oak to iron/);
    assert.match(r.Description, /1–3 months/);
});

test('canWriteNotes reads the granted scope string', () => {
    assert.equal(canWriteNotes({ grantedScopes: 'ZohoCRM.modules.leads.CREATE' }), false);
    assert.equal(canWriteNotes({ grantedScopes: 'ZohoCRM.modules.leads.CREATE,ZohoCRM.modules.notes.CREATE' }), true);
    assert.equal(canWriteNotes({ grantedScopes: 'ZohoCRM.modules.ALL.ALL' }), true);
    // unknown (env-var connection): try it rather than refuse pre-emptively
    assert.equal(canWriteNotes({ grantedScopes: '' }), true);
});

test('never builds a record Zoho must refuse: Last_Name and Company always set', () => {
    const r = buildLeadRecord(lead({ firstName: 'Sam', phone: '1' }), formConfig);
    assert.equal(r.Last_Name, 'Sam');
    const r2 = buildLeadRecord(lead({ phone: '1' }), formConfig);
    assert.equal(r2.Last_Name, 'Name not provided');
    assert.equal(r2.Company, 'Homeowner');
});

test('lead carries the filing category: source and status', () => {
    const cfg = { ...formConfig, show: { ...formConfig.show, leadStatus: 'Not Contacted' } };
    const r = buildLeadRecord(lead({ lastName: 'W', phone: '1' }), cfg);
    assert.equal(r.Lead_Source, 'Fall Home Show 2026');
    assert.equal(r.Lead_Status, 'Not Contacted');
    // no configured status -> field omitted entirely, so Zoho's default stands
    const r2 = buildLeadRecord(lead({ lastName: 'W', phone: '1' }), formConfig);
    assert.equal('Lead_Status' in r2, false);
});

test('datacenter normalizes and points at zohoapis, not accounts', () => {
    assert.equal(normalizeDatacenter('ca'), 'ca');
    assert.equal(normalizeDatacenter('nope'), 'com');
    assert.equal(apiBase('ca'), 'https://www.zohoapis.ca/crm/v7');
});
