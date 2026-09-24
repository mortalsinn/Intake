const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iw-journal-'));
const lead = (id, last) => ({ id, fields: { firstName: 'A', lastName: last } });

test('every submission is journalled the moment it arrives', () => {
    const dir = tmp();
    const store = createStore(dir);
    store.addLead(lead('a', 'One'));
    store.addLead(lead('b', 'Two'));

    const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(l => l.id), ['a', 'b']);
    assert.equal(lines[0].fields.lastName, 'One');
});

test('a lost leads.json is rebuilt from the journal', () => {
    const dir = tmp();
    let store = createStore(dir);
    store.addLead(lead('a', 'One'));
    store.addLead(lead('b', 'Two'));

    // The working file is destroyed — a bad write, a full disk, a stray rm.
    fs.unlinkSync(path.join(dir, 'leads.json'));

    store = createStore(dir);
    assert.equal(store.getLeads().length, 2, 'both recovered');
    assert.deepEqual(store.getLeads().map(l => l.fields.lastName).sort(), ['One', 'Two']);

    // Recovered leads must be usable, not just present: without the sync
    // bookkeeping rebuilt around them the next push sweep crashes on the
    // very entries it is meant to rescue.
    for (const l of store.getLeads()) {
        assert.ok(l.zoho, 'has zoho state');
        assert.equal(l.zoho.status, 'pending', 'assumed unsent, so it gets re-sent');
        assert.ok(l.uploadToken, 'has an upload token');
        assert.ok(Array.isArray(l.photos));
    }
    assert.equal(store.pendingLeads().length, 2, 'and they are queued for Zoho');
    assert.doesNotThrow(() => store.counts());
});

test('a CORRUPT leads.json is rebuilt rather than silently starting empty', () => {
    const dir = tmp();
    let store = createStore(dir);
    store.addLead(lead('a', 'One'));
    fs.writeFileSync(path.join(dir, 'leads.json'), '{ this is not json');

    store = createStore(dir);
    assert.equal(store.getLeads().length, 1);
    assert.equal(store.getLeads()[0].fields.lastName, 'One');
});

test('a torn final line costs that line and nothing else', () => {
    const dir = tmp();
    let store = createStore(dir);
    store.addLead(lead('a', 'One'));
    store.addLead(lead('b', 'Two'));
    // Simulate the process dying mid-append.
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"id":"c","fields":{"lastN');
    fs.unlinkSync(path.join(dir, 'leads.json'));

    store = createStore(dir);
    assert.equal(store.getLeads().length, 2, 'the two complete entries survive');
});

test('audit reports what the working set has lost, and restore brings it back', () => {
    const dir = tmp();
    const store = createStore(dir);
    store.addLead(lead('a', 'One'));
    store.addLead(lead('b', 'Two'));

    // Drop one from the working file only, leaving the journal intact.
    const live = JSON.parse(fs.readFileSync(path.join(dir, 'leads.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'leads.json'), JSON.stringify(live.filter(l => l.id === 'a')));

    const reopened = createStore(dir);
    const audit = reopened.auditJournal();
    assert.equal(audit.journalled, 2);
    assert.equal(audit.live, 1);
    assert.deepEqual(audit.missing.map(m => m.id), ['b']);

    assert.equal(reopened.restoreFromJournal(), 1);
    assert.equal(reopened.getLeads().length, 2);
    // Restored entries are queued for Zoho rather than assumed sent.
    assert.equal(reopened.getLeads().find(l => l.id === 'b').zoho.status, 'pending');
});

test('the journal keeps the record even after a lead is deleted from the working set', () => {
    const dir = tmp();
    const store = createStore(dir);
    store.addLead(lead('a', 'One'));
    store.updateLead('a', { status: 'synced', leadId: 'z1' });
    assert.equal(store.getJournal().length, 1, 'journalled once, unchanged by later edits');
});

test('starting fresh ARCHIVES everything — nothing is destroyed', () => {
    const dir = tmp();
    const store = createStore(dir);
    store.addLead(lead('a', 'One'));
    store.addLead(lead('b', 'Two'));
    fs.writeFileSync(path.join(dir, 'zoho.json'), '{"clientId":"keep-me"}');

    const r = store.archiveAll();
    assert.strictEqual(r.leads, 2);
    assert.strictEqual(store.getLeads().length, 0, 'the admin page starts at zero');
    assert.strictEqual(store.getJournal().length, 0, 'and so does the backup it checks against');

    const saved = path.join(dir, r.archivedTo);
    const kept = JSON.parse(fs.readFileSync(path.join(saved, 'leads.json'), 'utf8'));
    assert.deepStrictEqual(kept.map(l => l.id).sort(), ['a', 'b'], 'every lead is still on disk');
    assert.strictEqual(fs.readFileSync(path.join(saved, 'journal.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'zoho.json')), 'the Zoho connection is untouched');

    // A restart must not resurrect the archived leads from the old journal.
    const reopened = createStore(dir);
    assert.strictEqual(reopened.getLeads().length, 0);
    reopened.addLead(lead('c', 'Three'));
    assert.strictEqual(reopened.getLeads().length, 1, 'the next show captures normally');
    assert.strictEqual(reopened.auditJournal().missing.length, 0, '"Check nothing lost" is clean');
});
