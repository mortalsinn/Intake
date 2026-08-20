// ========================================================
// Filename: lib/validate.js
// Description: Server-side validation of an incoming lead
// against the form spec. The kiosk validates too, but the
// server is the durability layer, so it is deliberately
// lenient: reject only what is unusable, never what is
// merely incomplete — a half-filled lead from a real person
// at the booth is still a lead.
// ========================================================

function validateLead(body, formConfig) {
    const errors = [];
    if (!body || typeof body !== 'object') return ['Empty request'];
    if (!body.id || typeof body.id !== 'string' || body.id.length > 64) {
        errors.push('Missing submission id');
    }
    const fields = body.fields;
    if (!fields || typeof fields !== 'object') return [...errors, 'Missing fields'];

    for (const field of formConfig.fields) {
        const value = fields[field.id];
        const has = Array.isArray(value) ? value.length > 0
            : typeof value === 'boolean' ? value === true
            : value != null && String(value).trim() !== '';
        if (field.required && !has) errors.push(`${field.label} is required`);
        if (has && !Array.isArray(value) && typeof value !== 'boolean' && String(value).length > 2000) {
            errors.push(`${field.label} is too long`);
        }
    }

    if (formConfig.requirePhoneOrEmail) {
        const phone = String(fields.phone || '').trim();
        const email = String(fields.email || '').trim();
        if (!phone && !email) errors.push('A phone number or an email is required');
    }

    return errors;
}

module.exports = { validateLead };
