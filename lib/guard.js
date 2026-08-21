// ========================================================
// Filename: lib/guard.js
// Description: Abuse limits for a kiosk on the open internet.
//
// Deliberately in-memory: this is one small server, the
// windows are minutes long, and a restart clearing them is
// acceptable. A database here would be more moving parts for
// no more safety.
// ========================================================
const crypto = require('crypto');

/**
 * Compare two secrets without leaking their length or contents through
 * timing. `===` on a PIN returns faster the earlier it differs, which is
 * measurable over enough attempts.
 */
function safeEqual(a, b) {
    const x = Buffer.from(String(a ?? ''));
    const y = Buffer.from(String(b ?? ''));
    if (x.length !== y.length) {
        // Still compare something, so the mismatch costs the same time.
        crypto.timingSafeEqual(x, x);
        return false;
    }
    return crypto.timingSafeEqual(x, y);
}

/**
 * A sliding-window rate limiter keyed by whatever the caller chooses —
 * usually an IP, sometimes an upload token.
 */
function rateLimiter({ windowMs, max }) {
    const hits = new Map();
    return function check(key) {
        const now = Date.now();
        const fresh = (hits.get(key) || []).filter(t => now - t < windowMs);
        fresh.push(now);
        hits.set(key, fresh);
        // Opportunistic cleanup; this map must not grow forever.
        if (hits.size > 5000) {
            for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
        }
        return { allowed: fresh.length <= max, retryAfterMs: windowMs };
    };
}

/**
 * Lockout for secret guessing.
 *
 * A short PIN with unlimited attempts is not a secret, it is a delay. After
 * a handful of wrong guesses this stops answering at all for a while, which
 * turns a minutes-long brute force into a years-long one.
 */
function lockout({ maxAttempts = 5, lockMs = 15 * 60 * 1000 } = {}) {
    const state = new Map();   // key -> { fails, until }

    return {
        blocked(key) {
            const s = state.get(key);
            if (!s || !s.until) return false;
            if (Date.now() > s.until) { state.delete(key); return false; }
            return Math.ceil((s.until - Date.now()) / 1000);
        },
        fail(key) {
            const s = state.get(key) || { fails: 0, until: 0 };
            s.fails++;
            if (s.fails >= maxAttempts) {
                s.until = Date.now() + lockMs;
                s.fails = 0;
            }
            state.set(key, s);
            return s.until ? Math.ceil((s.until - Date.now()) / 1000) : 0;
        },
        succeed(key) { state.delete(key); },
    };
}

module.exports = { safeEqual, rateLimiter, lockout };
