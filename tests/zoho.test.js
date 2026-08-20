const test = require('node:test');
const assert = require('node:assert');
const { buildLeadRecord, buildNote, canWriteNotes, normalizeDatacenter, apiBase } = require('../lib/zoho');

const formConfig = {
    show: { name: 'Renovation Home Show', leadSource: 'Home Show', timeZone: 'America/Edmonton' },
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

test('Description keeps the capture line and points at the Notes', () => {
    const r = buildLeadRecord(lead({ lastName: 'Woo', phone: '1', notes: 'oak to iron' }), formConfig);
    assert.match(r.Description, /^Captured at the Renovation Home Show/);
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
    assert.match(note.Note_Title, /Booth intake/);
    const c = note.Note_Content;
    assert.match(c, /BOOTH ASSESSMENT/);
    assert.match(c, /HOT LEAD/);
    assert.match(c, /CONTACT/);
    assert.match(c, /\(403\) 555-0188/);
    assert.match(c, /WHAT THEY WANT/);
    assert.match(c, /Interior railing, Mirrors/);
    assert.match(c, /FROM THE CONVERSATION/);
    assert.match(c, /oak to iron, has photos/);
    assert.match(c, /CONSENT/);
    assert.match(c, /Agreed to be contacted/);
});

test('note omits sections that have no answers — no empty headings', () => {
    const note = buildNote(lead({ lastName: 'Woo', phone: '1' }), formConfig);
    assert.doesNotMatch(note.Note_Content, /BOOTH ASSESSMENT/);
    assert.doesNotMatch(note.Note_Content, /WHAT THEY WANT/);
    assert.doesNotMatch(note.Note_Content, /FROM THE CONVERSATION/);
});

test('refused consent is stated loudly in the note', () => {
    const note = buildNote(lead({ lastName: 'W', phone: '1', consent: false }), formConfig);
    assert.match(note.Note_Content, /NOT GIVEN — do not contact/);
});

test('withDetail is the no-notes-scope fallback: nothing is dropped', () => {
    const r = buildLeadRecord(lead({
        lastName: 'W', phone: '1', notes: 'oak to iron', timeline: '1–3 months', _boothRating: 'HOT LEAD',
    }), formConfig, { withDetail: true });
    assert.match(r.Description, /Booth assessment: HOT LEAD/);
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
    assert.equal(r2.Last_Name, 'Unknown (home show)');
    assert.equal(r2.Company, 'Homeowner');
});

test('lead carries the filing category: source and status', () => {
    const cfg = { ...formConfig, show: { ...formConfig.show, leadStatus: 'Not Contacted' } };
    const r = buildLeadRecord(lead({ lastName: 'W', phone: '1' }), cfg);
    assert.equal(r.Lead_Source, 'Home Show');
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
