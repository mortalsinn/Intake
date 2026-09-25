// ========================================================
// Filename: lib/mail.js
// Description: Code Compass leads, emailed to our own inbox.
//
// Code Compass demo requests never enter the CRM. Each one is
// emailed to info@ribitos.com (LEAD_EMAIL_TO) and nowhere else —
// the visitor is never mailed. Their address goes in Reply-To,
// so answering the notification answers the prospect.
//
// Transport is Resend's HTTP API, the same one RibitOS uses
// (backend/services/mailService.js), so one account and one
// verified domain serve both. No key, no sending: leads wait on
// disk exactly as they do when Zoho is down, and are sent the
// moment a key is configured.
// ========================================================

const RESEND_URL = 'https://api.resend.com/emails';

function mailConfig(env = process.env) {
    return {
        apiKey: env.RESEND_API_KEY || '',
        from: env.MAIL_FROM || 'RibitOS Home Show <info@ribitos.com>',
        to: env.LEAD_EMAIL_TO || 'info@ribitos.com',
    };
}

const canSend = (env = process.env) => !!mailConfig(env).apiKey;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The notification for one lead. The body is the same text the CRM note
 * would have carried — one wording for "what this person told us",
 * whichever inbox it lands in.
 */
function buildLeadEmail(lead, formConfig, noteText) {
    const f = lead.fields || {};
    const name = [f.firstName, f.lastName].filter(Boolean).join(' ') || 'Unnamed visitor';
    const company = f.company ? ` (${f.company})` : '';
    const subject = `${formConfig.show.noteTitle || 'Home show lead'}: ${name}${company}`;
    const html = `<pre style="font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${esc(noteText)}</pre>`;
    const replyTo = EMAIL.test(String(f.email || '').trim()) ? String(f.email).trim() : undefined;
    return { subject, text: noteText, html, replyTo };
}

/** Send one notification. Throws with `.permanent` for errors a retry will not fix. */
async function sendLeadEmail(message, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
    const { apiKey, from, to } = mailConfig(env);
    if (!apiKey) {
        const e = new Error('Email not configured: RESEND_API_KEY is not set.');
        e.notConfigured = true;
        throw e;
    }
    const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        // A hung connection must not hold the mail sweep forever: while it
        // waits, no other Code Compass lead can go.
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from, to: [to], subject: message.subject,
            html: message.html, text: message.text,
            reply_to: message.replyTo,
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = new Error(`Email refused (${res.status}): ${body.message || body.name || 'unknown error'}`);
        // 4xx other than rate limiting will not cure itself on a retry.
        e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        // 401 and 403 are Resend refusing the ACCOUNT, not the lead — a bad
        // key, or a From address on a domain not verified in Resend. Nothing
        // is wrong with the visitor's answers, and the day the setup is
        // fixed every one of them must go without anybody pressing Retry.
        e.setup = res.status === 401 || res.status === 403;
        throw e;
    }
    return { id: body.id || null, to };
}

/**
 * A test notification, for the admin page. Goes to the same inbox as a real
 * lead, from the same address, through the same call — so it proves exactly
 * the path a Code Compass lead takes, and brings back Resend's own words
 * when it is refused.
 */
function buildTestEmail(when = new Date()) {
    const text = [
        'This is a test from the home show intake app.',
        '',
        'If it reached this inbox, Code Compass demo requests will too.',
        `Sent ${when.toISOString()}.`,
    ].join('\n');
    return {
        subject: 'Home show intake: test email',
        text,
        html: `<pre style="font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${esc(text)}</pre>`,
    };
}

module.exports = { mailConfig, canSend, buildLeadEmail, buildTestEmail, sendLeadEmail };
