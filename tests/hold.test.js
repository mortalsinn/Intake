// ========================================================
// Filename: tests/hold.test.js
// Description: The server must still be holding a lead when the
// staff priority tap arrives.
//
// The priority screen comes AFTER the photograph QR and the
// thank-you, each of which waits for a tap. The hold used to be
// 20 seconds, so nearly every lead was sent before staff could
// rate it and the priority never reached the CRM or the email.
// ========================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, HOLD_MS } = require('../lib/store');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const ms = (name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(app);
    assert.ok(m, `${name} not found in app.js`);
    return Function(`return (${m[1]})`)();
};

test('the hold outlasts the longest flow the kiosk can run before the priority tap', () => {
    const longest = ms('QR_BAIL_MS') + ms('THANKS_BAIL_MS') + ms('STAFF_DELAY_MS') + ms('STAFF_BAIL_MS');
    assert.ok(HOLD_MS > longest,
        `hold ${HOLD_MS / 1000}s must exceed QR + thank you + hand-back + staff step (${longest / 1000}s)`);
});

test('a new lead is held, and released the moment the kiosk lets go', () => {
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'iw-hold-')));
    store.addLead({ id: 'h1', kind: 'enquiry', fields: { firstName: 'A', lastName: 'B' } });
    assert.strictEqual(store.pendingLeads().length, 0, 'held while staff may still rate it');
    store.releaseHold('h1');
    assert.strictEqual(store.pendingLeads().length, 1, 'sent as soon as it is released');
});
