// ========================================================
// Filename: tests/brands.test.js
// Description: One iPad, two companies — the guarantee that a
// Code Compass demo request can never be filed as an Ironwood
// railing enquiry, and vice versa.
//
// This is the test that matters most about the multi-brand
// kiosk. Both brands share the queue, the disk, the CSV export
// and the Zoho pusher; the ONLY thing keeping them apart is
// that every one of those reads the config for the lead's own
// kind. A single hoisted config — which is what the pusher
// originally had — files every brand under the first one, and
// nothing about that failure looks like an error.
// ========================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildLeadRecord, buildNote } = require('../lib/zoho');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const cfg = (f) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));

const ironwood = cfg('form.json');
const ribit = cfg('ribit-form.json');
const brands = cfg('brands.json');

const lead = (kind) => ({
    id: `x-${kind}`,
    kind,
    submittedAt: '2026-09-15T18:00:00.000Z',
    fields: { firstName: 'Dana', lastName: 'Woo', phone: '(403) 555-0188', email: 'd@e.com', consent: true },
});

test('Ironwood leads land in the first column, tagged with the show', () => {
    // Not a status column made for one weekend: the ordinary first column,
    // found by searching the tag.
    const rec = buildLeadRecord(lead('enquiry'), ironwood, {});
    assert.strictEqual(rec.Lead_Status, 'Contact in Future');
    assert.deepStrictEqual(ironwood.show.tags, ['Fall Home Show 2026']);
});

test('Code Compass carries nothing that could file it in the CRM', () => {
    // Code Compass leads are emailed to info@ribitos.com and never enter the
    // CRM. A spec with a Lead Source or an owner is one config slip from
    // filing them there again.
    assert.strictEqual(ribit.show.leadSource, undefined);
    assert.strictEqual(ribit.show.leadStatus, undefined);
    assert.strictEqual(ribit.show.leadOwner, undefined);
    assert.strictEqual(ribit.show.tags, undefined);
});

test('a Ribit lead never carries Ironwood wording or its lead owner', () => {
    const rec = buildLeadRecord(lead('ribit'), ribit, { withDetail: true });
    assert.doesNotMatch(rec.Description, /Ironwood/i);
    const note = buildNote(lead('ribit'), ribit);
    assert.doesNotMatch(note.Note_Content, /Ironwood/i);
    assert.doesNotMatch(note.Note_Content, /PROJECT ENQUIRY/);
    assert.match(note.Note_Content, /DEMO REQUEST/);
    assert.match(note.Note_Title, /Code Compass/);
    // Ironwood's booth leads all go to one owner. Ribit's must not inherit
    // that person by accident just because the field exists on the spec.
    assert.notStrictEqual(
        ribit.show.leadOwner?.id,
        ironwood.show.leadOwner?.id,
        'Ribit must not silently inherit Ironwood\'s lead owner',
    );
});

test('Ironwood keeps its own wording — the Ribit config did not bleed back', () => {
    const note = buildNote(lead('enquiry'), ironwood);
    assert.match(note.Note_Content, /PROJECT ENQUIRY/);
    assert.match(note.Note_Content, /Ironwood intake application/);
    assert.doesNotMatch(note.Note_Content, /Ribit/i);
});

test('the consent wording recorded names the right company', () => {
    // Express consent is only evidence if it proves WHAT was agreed to.
    // Recording Ironwood's sentence against a Ribit lead would be worse
    // than recording nothing.
    assert.match(buildNote(lead('ribit'), ribit).Note_Content, /Ribit may contact me/);
    assert.match(buildNote(lead('enquiry'), ironwood).Note_Content, /Ironwood Stair & Rail Inc\. may contact me/);
});

test('every brand in the chooser points at a kind the server can serve', () => {
    // A typo here is a dead button on the booth iPad: the tap loads no spec
    // and the visitor gets whatever form was last on screen.
    const SERVED = new Set(['enquiry', 'contest', 'ribit']);
    assert.ok(brands.brands.length > 1, 'brands.json should describe more than one booth');
    for (const b of brands.brands) {
        assert.ok(b.ctas?.length, `${b.id} has no call to action`);
        for (const cta of b.ctas) {
            assert.ok(SERVED.has(cta.kind), `${b.id} offers unknown kind "${cta.kind}"`);
            assert.ok(cta.label, `${b.id} has a call to action with no label`);
        }
        assert.ok(b.logo, `${b.id} has no logo`);
        assert.ok(
            fs.existsSync(path.join(__dirname, '..', 'public', b.logo)),
            `${b.id} logo ${b.logo} is not in public/`,
        );
        if (b.cardLogo) {
            assert.ok(
                fs.existsSync(path.join(__dirname, '..', 'public', b.cardLogo)),
                `${b.id} cardLogo ${b.cardLogo} is not in public/`,
            );
        }
    }
});

test('Ribit asks nothing that needs Ironwood-only machinery', () => {
    // The inspiration gallery is scraped from ironwoodstairs.com. A Ribit
    // form offering it would open a picker full of railings.
    assert.ok(!ribit.fields.some(f => f.type === 'inspiration'));
});

test('a brand config Zoho would refuse is caught here, not at the booth', () => {
    for (const [name, c] of [['ironwood', ironwood], ['ribit', ribit]]) {
        const rec = buildLeadRecord(lead('x'), c, {});
        assert.ok(rec.Last_Name, `${name}: Zoho refuses a lead with no Last_Name`);
        assert.ok(rec.Company, `${name}: many orgs mark Company mandatory`);
        // Zoho ACCEPTS an unknown Lead_Status without complaint and stores
        // it, then has no Kanban column for it — those leads pile up under
        // "Unaccounted", struck through. Only set one you know exists.
        if (c.show.leadStatus) {
            assert.strictEqual(typeof c.show.leadStatus, 'string');
        }
        assert.doesNotMatch(JSON.stringify(rec), /[\u{1F300}-\u{1FAFF}]/u, `${name}: Zoho renders emoji as "?"`);
    }
});

test('a follow-up field is a REAL field, so its answer reaches the CRM', () => {
    // The Zoho note, the CSV export and the server's validation all walk
    // config.fields. An "Other" box bolted onto the pill it belongs to
    // would be captured on the iPad and reach none of them.
    const conditionals = ribit.fields.filter(f => f.showWhen);
    assert.ok(conditionals.length, 'the Ribit form should have follow-up fields');
    for (const f of conditionals) {
        assert.ok(f.crmLabel, `${f.id} needs a crmLabel or the note shows a raw id`);
        const trigger = ribit.fields.find(t => t.id === f.showWhen.field);
        assert.ok(trigger, `${f.id} points at a field that does not exist`);
        const opts = trigger.options || (trigger.groups || []).flatMap(g => g.options);
        for (const want of [].concat(f.showWhen.is)) {
            assert.ok(opts.includes(want),
                `${f.id} waits for "${want}", which ${trigger.id} never offers`);
        }
        assert.strictEqual(f.section, trigger.section,
            `${f.id} must sit on the same step as ${trigger.id} or it can never be seen`);
        assert.ok(!f.required, `${f.id} is conditional, so it must not be required`);
    }
});

test('a follow-up answer is written into the note', () => {
    const withOther = {
        ...lead('ribit'),
        fields: { firstName: 'Dana', lastName: 'Woo', role: 'Other', roleOther: 'Building official' },
    };
    const note = buildNote(withOther, ribit).Note_Content;
    assert.match(note, /Building official/);
});

test('no form asks about a "building department" — Alberta has no such body', () => {
    // Under the Safety Codes Act the municipality is the AUTHORITY HAVING
    // JURISDICTION and the person who answers a code question is a SAFETY
    // CODES OFFICER. Getting this wrong in front of builders reads as not
    // knowing the industry.
    for (const [name, c] of [['ironwood', ironwood], ['ribit', ribit]]) {
        const text = JSON.stringify(c);
        assert.doesNotMatch(text, /building department/i, `${name} says "building department"`);
        assert.doesNotMatch(text, /code enforcement office/i, `${name} invents a body`);
    }
});

test('the Code Compass form offers only what is public', () => {
    // Estimating, photo inspection, tender review and project tracking are
    // not released. Offering them at the booth promised a product nobody
    // could be shown.
    const text = JSON.stringify(ribit).toLowerCase();
    for (const unreleased of ['wider platform', 'estimating', 'photo inspection', 'tender', 'project tracking']) {
        assert.ok(!text.includes(unreleased), `the Code Compass form mentions "${unreleased}"`);
    }
});
