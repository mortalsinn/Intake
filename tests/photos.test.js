const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iw-photo-'));
const jpg = Buffer.from('ffd8ffe000104a464946', 'hex'); // enough to stand in for one

test('every lead gets an unguessable upload token', () => {
    const store = createStore(tmp());
    const a = store.addLead({ id: 'a', fields: {} });
    const b = store.addLead({ id: 'b', fields: {} });
    assert.ok(a.uploadToken.length >= 10);
    assert.notEqual(a.uploadToken, b.uploadToken);
    assert.equal(store.leadByUploadToken(a.uploadToken).id, 'a');
    assert.equal(store.leadByUploadToken('not-a-token'), null);
});

test('a resubmitted lead keeps its original token — no orphaned links', () => {
    const store = createStore(tmp());
    const first = store.addLead({ id: 'a', fields: {} });
    const again = store.addLead({ id: 'a', fields: {} });
    assert.equal(again.added, false);
    assert.equal(again.uploadToken, first.uploadToken);
});

test('a link older than the policy resolves to nothing', () => {
    const store = createStore(tmp());
    const { uploadToken } = store.addLead({ id: 'a', fields: {} });
    assert.ok(store.leadByUploadToken(uploadToken, { maxAgeDays: 7 }));
    // Backdate the capture by eight days; the seven-day policy must refuse it.
    const lead = store.getLeads()[0];
    lead.receivedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(store.leadByUploadToken(uploadToken, { maxAgeDays: 7 }), null);
});

test('photographs are held on disk, not inlined into the lead log', () => {
    const dir = tmp();
    const store = createStore(dir);
    store.addLead({ id: 'a', fields: {} });
    const rec = store.addPhoto('a', { buffer: jpg, filename: 'stairs.jpg', mimeType: 'image/jpeg' });
    assert.equal(rec.status, 'pending');
    assert.deepEqual(store.readPhoto(rec.file), jpg);
    // the JSON log holds a pointer, never the bytes
    const raw = fs.readFileSync(path.join(dir, 'leads.json'), 'utf8');
    assert.doesNotMatch(raw, /ffd8ffe0/i);
    assert.match(raw, new RegExp(rec.file));
});

test('a photograph waits for its lead to exist in Zoho', () => {
    const store = createStore(tmp());
    store.addLead({ id: 'a', fields: {} });
    store.addPhoto('a', { buffer: jpg });
    assert.equal(store.leadsWithPendingPhotos().length, 1);
    assert.deepEqual(store.photoCounts(), { pending: 1, uploaded: 0, failed: 0 });
});

test('an uploaded photograph releases its local copy', () => {
    const dir = tmp();
    const store = createStore(dir);
    store.addLead({ id: 'a', fields: {} });
    const rec = store.addPhoto('a', { buffer: jpg });
    store.markPhoto('a', rec.file, { status: 'uploaded' });
    assert.deepEqual(store.photoCounts(), { pending: 0, uploaded: 1, failed: 0 });
    assert.equal(store.leadsWithPendingPhotos().length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'photos', rec.file)), false);
});

test('the staff priority tap catches the lead inside its grace period', () => {
    const store = createStore(tmp());
    store.addLead({ id: 'a', fields: { lastName: 'Woo' } });
    assert.equal(store.pendingLeads().length, 0, 'held, awaiting a possible tap');
    store.setPriority('a', 'High priority');
    store.releaseHold('a');
    assert.equal(store.pendingLeads().length, 1);
    assert.equal(store.getLeads()[0].fields._boothRating, 'High priority');
});
