const test = require('node:test');
const assert = require('node:assert');
const { safeEqual, rateLimiter, lockout } = require('../lib/guard');

test('safeEqual matches correctly and tolerates junk', () => {
    assert.equal(safeEqual('162534', '162534'), true);
    assert.equal(safeEqual('162534', '162535'), false);
    assert.equal(safeEqual('short', 'muchlonger'), false, 'length mismatch must not throw');
    assert.equal(safeEqual(undefined, '1234'), false);
    assert.equal(safeEqual(null, null), true);
});

test('rate limiter allows a normal booth and stops a flood', () => {
    const check = rateLimiter({ windowMs: 60000, max: 3 });
    assert.equal(check('1.2.3.4').allowed, true);
    assert.equal(check('1.2.3.4').allowed, true);
    assert.equal(check('1.2.3.4').allowed, true);
    assert.equal(check('1.2.3.4').allowed, false, 'fourth in the window is refused');
    // A different visitor is unaffected.
    assert.equal(check('5.6.7.8').allowed, true);
});

test('PIN lockout stops guessing after a handful of tries', () => {
    const lock = lockout({ maxAttempts: 3, lockMs: 60000 });
    assert.equal(lock.blocked('ip'), false);
    lock.fail('ip'); lock.fail('ip');
    assert.equal(lock.blocked('ip'), false, 'two wrong guesses is not a lockout');
    lock.fail('ip');
    assert.ok(lock.blocked('ip') > 0, 'the third locks it');
});

test('a correct PIN clears the failure count', () => {
    const lock = lockout({ maxAttempts: 3, lockMs: 60000 });
    lock.fail('ip'); lock.fail('ip');
    lock.succeed('ip');
    lock.fail('ip'); lock.fail('ip');
    assert.equal(lock.blocked('ip'), false, 'the counter restarted after success');
});

test('lockout expires on its own', () => {
    const lock = lockout({ maxAttempts: 1, lockMs: 1 });
    lock.fail('ip');
    return new Promise(r => setTimeout(() => {
        assert.equal(lock.blocked('ip'), false);
        r();
    }, 15));
});
