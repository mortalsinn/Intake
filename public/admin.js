// Staff admin: live sync status, Zoho connect, CSV export, retry.
(() => {
    const $ = (sel) => document.querySelector(sel);
    let pin = sessionStorage.getItem('iw_admin_pin') || '';

    const api = (path, opts = {}) => fetch(path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin, ...(opts.headers || {}) },
    });

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
              <td><span class="badge ${badgeCls}" title="${z.error || ''}">${zText}</span></td>
              <td>${retry}</td></tr>`;
        }).join('') || '<tr><td colspan="7" style="color:#888">No enquiries recorded yet.</td></tr>';
        return true;
    }

    $('#pin-go').addEventListener('click', async () => {
        pin = $('#pin').value.trim();
        sessionStorage.setItem('iw_admin_pin', pin);
        await refresh();
    });

    $('#btn-retry').addEventListener('click', () => api('/api/admin/retry', { method: 'POST', body: '{}' }).then(refresh));

    document.addEventListener('click', (e) => {
        const id = e.target?.dataset?.retry;
        if (id) api('/api/admin/retry', { method: 'POST', body: JSON.stringify({ id }) }).then(refresh);
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

    if (pin) refresh(); else $('#pin-gate').hidden = false;
    setInterval(() => { if (!$('#panel').hidden) refresh(); }, 10 * 1000);
})();
