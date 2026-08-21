// Staff admin: live sync status, Zoho connect, CSV export, retry.
(() => {
    const $ = (sel) => document.querySelector(sel);
    let pin = sessionStorage.getItem('iw_admin_pin') || '';

    const api = (path, opts = {}) => fetch(path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin, ...(opts.headers || {}) },
    });

    // Photographs a customer sent from their own phone, per enquiry.
    const photoCell = (l) => {
        const ps = l.photos || [];
        if (!ps.length) return '—';
        const up = ps.filter(p => p.status === 'uploaded').length;
        const bad = ps.filter(p => p.status === 'failed').length;
        if (bad) return `<span class="badge bad">${up}/${ps.length}</span>`;
        return up === ps.length
            ? `<span class="badge ok">${up}</span>`
            : `<span class="badge warn">${up}/${ps.length}</span>`;
    };

    async function refresh() {
        const res = await api('/api/admin/status');
        if (res.status === 401) {
            sessionStorage.removeItem('iw_admin_pin');
            $('#panel').hidden = true;
            $('#pin-gate').hidden = false;
            $('#pin-msg').textContent = pin ? 'Incorrect PIN.' : '';
            return false;
        }
        const s = await res.json();
        $('#pin-gate').hidden = true;
        $('#panel').hidden = false;

        $('#c-total').textContent = s.counts.total;
        $('#c-synced').textContent = s.counts.synced;
        const ph = s.photos || { pending: 0, uploaded: 0, failed: 0 };
        $('#c-photos').textContent = ph.uploaded + (ph.pending ? ` (+${ph.pending} pending)` : '')
            + (ph.failed ? ` (${ph.failed} failed)` : '');
        $('#c-pending').textContent = s.counts.pending + (s.counts.failed ? ` (+${s.counts.failed} declined)` : '');

        const badge = $('#zoho-badge');
        if (!s.zoho.connected) {
            badge.className = 'badge bad';
            badge.textContent = 'Not connected — enquiries are held securely on this server';
            $('#zoho-setup').open = true;
        } else if (!s.zoho.hasLeadScope) {
            badge.className = 'badge warn';
            badge.textContent = `Connected (${s.zoho.datacenter}) — token is missing the Leads permission; please reconnect`;
        } else if (!s.zoho.hasNoteScope) {
            // Leads still land; the booth detail falls back into Description.
            badge.className = 'badge bad';
            badge.textContent = s.zoho.noteScopeProblem
                ? 'Zoho declined a note — this token lacks the Notes permission. Reconnect below, then select "Retry unsent".'
                : 'Connected — Notes permission missing. Reconnect to file details as Notes.';
            $('#zoho-setup').open = true;
        } else {
            badge.className = 'badge ok';
            badge.textContent = `Connected — zoho.${s.zoho.datacenter}`;
        }
        if (s.zoho.requiredScope) $('#scope-str').textContent = s.zoho.requiredScope;

        $('#rows').innerHTML = s.leads.map(l => {
            const f = l.fields || {};
            const name = [f.firstName, f.lastName].filter(Boolean).join(' ') || '—';
            const contact = [f.phone, f.email].filter(Boolean).join(' · ') || '—';
            const interests = Array.isArray(f.interests) ? f.interests.join(', ') : '';
            const z = l.zoho || {};
            const badgeCls = z.status === 'synced' ? 'ok' : z.status === 'failed' ? 'bad' : 'warn';
            const zText = z.status === 'synced' ? (z.noteError ? 'Recorded — note failed' : 'Recorded')
                : z.status === 'failed' ? `Declined: ${z.error || ''}` : 'Awaiting transfer';
            const retry = z.status === 'failed' ? `<button class="ghost" data-retry="${l.id}">Retry</button>` : '';
            // Shorten the CRM-facing phrasing for the table column.
            const rating = (f._boothRating || '').replace(/\s*—.*$/, '');
            return `<tr>
              <td>${new Date(l.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
              <td>${rating}</td>
              <td>${name}</td><td>${contact}</td><td>${interests}</td>
              <td>${photoCell(l)}</td>
              <td><span class="badge ${badgeCls}" title="${z.error || ''}">${zText}</span></td>
              <td>${retry}</td></tr>`;
        }).join('') || '<tr><td colspan="8" style="color:#888">No enquiries recorded yet.</td></tr>';
        return true;
    }

    $('#pin-go').addEventListener('click', async () => {
        pin = $('#pin').value.trim();
        sessionStorage.setItem('iw_admin_pin', pin);
        await refresh();
    });

    $('#btn-retry').addEventListener('click', () => api('/api/admin/retry', { method: 'POST', body: '{}' }).then(refresh));

    $('#btn-verify').addEventListener('click', async () => {
        const msg = $('#verify-msg');
        msg.className = 'msg';
        msg.textContent = 'Checking…';
        try {
            const r = await (await api('/api/admin/verify')).json();
            msg.className = `msg ${r.canReadLeads ? 'ok' : 'bad'}`;
            msg.textContent = r.canReadLeads
                ? `✓ ${r.detail}`
                : `✗ ${r.detail || 'Connection could not be verified.'}`;
        } catch {
            msg.className = 'msg bad';
            msg.textContent = 'Could not reach the server.';
        }
        refresh();
    });

    document.addEventListener('click', (e) => {
        const id = e.target?.dataset?.retry;
        if (id) api('/api/admin/retry', { method: 'POST', body: JSON.stringify({ id }) }).then(refresh);
    });

    // The one button that checks all three layers agree with each other.
    $('#btn-audit').addEventListener('click', async () => {
        const msg = $('#verify-msg');
        msg.className = 'msg';
        msg.textContent = 'Checking device, server and Zoho…';
        try {
            const a = await (await api('/api/admin/audit')).json();
            const lines = [];
            lines.push(`Journal holds ${a.journal.recorded}, working file holds ${a.journal.live}.`);
            if (a.journal.missingFromWorkingSet.length) {
                lines.push(`⚠ ${a.journal.missingFromWorkingSet.length} in the journal are MISSING from the working file — press Restore.`);
            }
            if (a.zoho.checked) {
                lines.push(`Zoho holds ${a.zoho.inCrmForThisShow} for "${a.zoho.source}". We believe ${a.zoho.weBelieveSynced} were sent; ${a.zoho.notYetSent} not sent yet.`);
                if (a.zoho.missingFromCrm.length) {
                    lines.push(`⚠ ${a.zoho.missingFromCrm.length} we sent are NOT in Zoho: ` +
                        a.zoho.missingFromCrm.map(m => m.name || m.leadId).join(', '));
                }
            } else if (a.zoho.error) {
                lines.push(`Could not check Zoho: ${a.zoho.error}`);
            }
            msg.className = `msg ${a.ok ? 'ok' : 'bad'}`;
            msg.textContent = (a.ok ? '✓ Nothing lost. ' : '⚠ ') + lines.join(' ');
        } catch {
            msg.className = 'msg bad';
            msg.textContent = 'Could not run the check.';
        }
        refresh();
    });

    $('#btn-journal').addEventListener('click', async () => {
        const res = await api('/api/admin/journal.jsonl');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'intake-journal.jsonl';
        a.click();
        URL.revokeObjectURL(a.href);
    });

    $('#btn-export').addEventListener('click', async () => {
        const res = await api('/api/admin/export.csv');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'homeshow-leads.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    });

    $('#z-connect').addEventListener('click', async () => {
        const msg = $('#z-msg');
        msg.className = 'msg';
        msg.textContent = 'Connecting…';
        const res = await api('/api/admin/zoho/connect', {
            method: 'POST',
            body: JSON.stringify({
                clientId: $('#z-id').value.trim(),
                clientSecret: $('#z-secret').value.trim(),
                datacenter: $('#z-dc').value,
                code: $('#z-code').value.trim(),
            }),
        });
        const data = await res.json();
        if (res.ok) {
            msg.className = 'msg ok';
            msg.textContent = 'Connected. Pending enquiries are now transferring.';
            $('#z-code').value = '';
            $('#zoho-setup').open = false;
        } else {
            msg.className = 'msg bad';
            msg.textContent = data.error || 'Failed';
        }
        refresh();
    });

    // The kiosk and this page share an origin, so this page can read the
    // iPad's own permanent archive directly. On any other machine it is
    // simply empty, which is the honest answer.
    const ARCHIVE_KEY = 'iw_intake_archive_v1';
    function deviceRows() {
        try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]'); } catch { return []; }
    }
    function paintDeviceCount() {
        const n = deviceRows().length;
        $('#device-count').textContent = n
            ? `${n} captured on this device`
            : 'None captured on this device';
    }
    $('#btn-device').addEventListener('click', () => {
        const rows = deviceRows();
        if (!rows.length) return alert('This device has not captured any enquiries.\n\nOpen this page on the booth iPad to download its copy.');
        const keys = [...new Set(rows.flatMap(r => Object.keys(r.fields || {})))].filter(k => !k.startsWith('_'));
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [
            ['capturedAt', ...keys, 'priority', 'inspiration'].map(esc).join(','),
            ...rows.map(r => [
                r.submittedAt,
                ...keys.map(k => { const v = r.fields?.[k]; return Array.isArray(v) ? v.join('; ') : v ?? ''; }),
                r.fields?._boothRating || '',
                (r.fields?._inspiration || []).join('; '),
            ].map(esc).join(',')),
        ].join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = `ironwood-device-copy-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });
    paintDeviceCount();

    if (pin) refresh(); else $('#pin-gate').hidden = false;
    setInterval(() => { if (!$('#panel').hidden) refresh(); }, 10 * 1000);
})();
