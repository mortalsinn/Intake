const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iw-store-'));

test('addLead dedupes on id — the iPad retry loop must be safe', () => {
    const store = createStore(tmp());
    assert.equal(store.addLead({ id: 'a', fields: { lastName: 'X' } }).added, true);
    assert.equal(store.addLead({ id: 'a', fields: { lastName: 'X' } }).added, false);
    assert.equal(store.getLeads().length, 1);
});

test('leads survive a restart (persisted to disk)', () => {
    const dir = tmp();
    createStore(dir).addLead({ id: 'a', fields: { lastName: 'X' } });
    const reopened = createStore(dir);
    assert.equal(reopened.getLeads().length, 1);
    assert.equal(reopened.getLeads()[0].zoho.status, 'pending');
});

test('updateLead moves status and counts follow', () => {
    const store = createStore(tmp());
    store.addLead({ id: 'a', fields: {} });
    store.addLead({ id: 'b', fields: {} });
    store.updateLead('a', { status: 'synced', leadId: 'z1' });
    assert.deepEqual(store.counts(), { total: 2, synced: 1, pending: 1, failed: 0 });
    assert.equal(store.pendingLeads().length, 1);
});

test('retry() puts failed leads back in the pending pool', () => {
    const store = createStore(tmp());
    store.addLead({ id: 'a', fields: {} });
    store.updateLead('a', { status: 'failed', error: 'INVALID_DATA' });
    assert.equal(store.retry(), 1);
    assert.equal(store.pendingLeads().length, 1);
    assert.equal(store.pendingLeads()[0].zoho.error, undefined);
});
