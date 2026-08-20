// ========================================================
// Filename: public/app.js
// Description: Kiosk form — renders from /api/form, queues
// submissions locally, syncs when the network allows.
//
// The queue in localStorage is the source of truth until the
// server acknowledges. Home-show wifi drops constantly; the
// visitor always sees instant success, and the little pill in
// the corner tells STAFF what has actually landed.
// ========================================================
(() => {
    const QUEUE_KEY = 'iw_intake_queue_v1';
    const DEAD_KEY = 'iw_intake_dead_v1';

    let config = null;
    const state = {}; // fieldId -> value

    const $ = (sel) => document.querySelector(sel);
    const form = $('#lead-form');

    // ---------- local queue ----------

    const loadQueue = () => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    const saveQueue = (q) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    const loadDead = () => JSON.parse(localStorage.getItem(DEAD_KEY) || '[]');

    let syncing = false;
    let holdFlush = false; // true while the thank-you screen awaits a staff rating
    async function flushQueue() {
        if (syncing || holdFlush) return;
        syncing = true;
        try {
            let queue = loadQueue();
            for (const item of queue.slice()) {
                try {
                    const res = await fetch('/api/leads', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item),
                    });
                    if (res.ok) {
                        queue = queue.filter(q => q.id !== item.id);
                        saveQueue(queue);
                    } else if (res.status === 400) {
                        // The server called the data unusable; retrying the same
                        // payload forever would wedge the queue. Park it where
                        // staff can still recover it rather than losing it.
                        const dead = loadDead();
                        dead.push({ ...item, error: (await res.json().catch(() => ({}))).error });
                        localStorage.setItem(DEAD_KEY, JSON.stringify(dead));
                        queue = queue.filter(q => q.id !== item.id);
                        saveQueue(queue);
                    } else {
                        break; // server trouble — try the whole queue again later
                    }
                } catch {
                    break; // offline — later
                }
            }
        } finally {
            syncing = false;
            paintSyncPill();
        }
    }

    function paintSyncPill() {
        const pill = $('#sync-pill');
        const waiting = loadQueue().length;
        const dead = loadDead().length;
        pill.hidden = false;
        if (dead) {
            pill.textContent = `${dead} need attention — see admin`;
            pill.className = 'sync-pill dead';
        } else if (waiting) {
            pill.textContent = `${waiting} saved on iPad — waiting for wifi`;
            pill.className = 'sync-pill wait';
        } else {
            pill.textContent = 'All entries synced';
            pill.className = 'sync-pill ok';
        }
    }

    // ---------- rendering ----------

    function fieldEl(field) {
        const wrap = document.createElement('div');
        wrap.className = `field${field.half ? ' half' : ''}`;
        wrap.dataset.id = field.id;

        if (field.type === 'consent') {
            wrap.innerHTML = `
              <div class="consent-row" role="checkbox" aria-checked="false" tabindex="0">
                <div class="box">✓</div><span class="txt">${field.label}</span>
              </div>
              <div class="err">Please tick this box so we're allowed to follow up.</div>`;
            const row = wrap.querySelector('.consent-row');
            row.addEventListener('click', () => {
                state[field.id] = !state[field.id];
                row.classList.toggle('on', !!state[field.id]);
                row.setAttribute('aria-checked', String(!!state[field.id]));
                wrap.classList.remove('invalid');
            });
            return wrap;
        }

        if (field.type === 'choice' || field.type === 'multi') {
            wrap.innerHTML = `
              <label class="title">${field.label}${field.required ? ' <span class="req">*</span>' : ''}</label>
              <div class="err">Please pick one.</div>`;
            const err = wrap.querySelector('.err');
            // Options can be flat or grouped under headings ("Glass", …);
            // a flat list is just one unlabelled group.
            const groups = field.groups || [{ options: field.options || [] }];
            for (const group of groups) {
                if (group.label) {
                    const h = document.createElement('div');
                    h.className = 'group-label';
                    h.textContent = group.label;
                    wrap.insertBefore(h, err);
                }
                const pills = document.createElement('div');
                pills.className = 'pills';
                for (const opt of group.options || []) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'pill';
                    b.textContent = opt;
                    b.addEventListener('click', () => {
                        if (field.type === 'choice') {
                            state[field.id] = state[field.id] === opt ? '' : opt;
                            for (const p of wrap.querySelectorAll('.pill')) p.classList.toggle('on', p.textContent === state[field.id]);
                        } else {
                            const cur = new Set(state[field.id] || []);
                            cur.has(opt) ? cur.delete(opt) : cur.add(opt);
                            state[field.id] = [...cur];
                            b.classList.toggle('on');
                        }
                        wrap.classList.remove('invalid');
                    });
                    pills.appendChild(b);
                }
                wrap.insertBefore(pills, err);
            }
            return wrap;
        }

        const isArea = field.type === 'textarea';
        wrap.innerHTML = `
          <label class="title" for="f-${field.id}">${field.label}${field.required ? ' <span class="req">*</span>' : ''}</label>
          ${isArea
            ? `<textarea id="f-${field.id}" placeholder="${field.placeholder || ''}"></textarea>`
            : `<input id="f-${field.id}" type="${field.type}" placeholder="${field.placeholder || ''}"
                 autocapitalize="${field.autocapitalize || 'off'}" autocorrect="off" spellcheck="false"
                 ${field.type === 'email' ? 'inputmode="email"' : ''} ${field.type === 'tel' ? 'inputmode="tel" maxlength="16"' : ''} />`}
          <div class="err">This one's required.</div>`;
        const input = wrap.querySelector('input, textarea');

        input.addEventListener('input', (e) => {
            if (field.type === 'tel') {
                // Backspacing over ")" or "-" must eat a digit, or the mask
                // would instantly redraw the same string and trap the cursor.
                let v = input.value;
                if (e.inputType === 'deleteContentBackward' && /\D$/.test(v)) {
                    v = v.replace(/\D+$/, '').slice(0, -1);
                }
                input.value = formatPhone(v);
            }
            state[field.id] = input.value;
            wrap.classList.remove('invalid');
            $('#form-err')?.classList.remove('show');
        });

        // Tidy-on-blur: names and cities get their capitals, emails get
        // trimmed and lowercased. Never mid-typing — fighting the keyboard
        // loses; fixing what they left behind wins.
        input.addEventListener('blur', () => {
            if (field.type === 'email') input.value = input.value.trim().toLowerCase();
            else if (field.autocapitalize === 'words') input.value = capWords(input.value);
            if (input.value !== (state[field.id] || '')) state[field.id] = input.value;
        });

        // Return key hops to the next field instead of submitting a
        // half-finished form (the iPad keyboard's "go" would otherwise).
        if (!isArea) {
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const inputs = [...form.querySelectorAll('input, textarea')];
                inputs[inputs.indexOf(input) + 1]?.focus();
            });
        }

        // One-tap suggestions (e.g. nearby cities) — typing is the enemy.
        if (Array.isArray(field.suggest) && field.suggest.length) {
            const sug = document.createElement('div');
            sug.className = 'suggest';
            for (const opt of field.suggest) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'chip';
                b.textContent = opt;
                b.addEventListener('click', () => {
                    input.value = opt;
                    state[field.id] = opt;
                    wrap.classList.remove('invalid');
                });
                sug.appendChild(b);
            }
            wrap.appendChild(sug);
        }
        return wrap;
    }

    // (403) 555-0123, progressively as digits arrive; tolerates a leading 1.
    function formatPhone(raw) {
        let d = String(raw).replace(/\D/g, '').slice(0, 11);
        let pre = '';
        if (d.length === 11 && d[0] === '1') { pre = '1 '; d = d.slice(1); }
        if (d.length > 10) d = d.slice(0, 10);
        if (d.length <= 3) return pre + d;
        if (d.length <= 6) return `${pre}(${d.slice(0, 3)}) ${d.slice(3)}`;
        return `${pre}(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    }

    // Uppercase the first letter of each word; never lowercase what's there,
    // so "McLean" typed correctly stays "McLean".
    const capWords = (s) => s.replace(/(^|[\s\-'])(\p{Ll})/gu, (m, p, c) => p + c.toUpperCase());

    function render() {
        document.title = `${config.show.name} — Ironwood Stair & Rail`;
        $('#headline').textContent = config.show.headline || 'Tell us about your project';
        $('#subhead').textContent = config.show.subhead || '';
        $('#thanks-headline').textContent = config.show.thanks || 'Thanks!';
        $('#thanks-sub').textContent = config.show.thanksSub || '';
        if (config.show.attractLine) $('#attract-line').textContent = config.show.attractLine;

        form.innerHTML = '';
        config.fields.forEach((field, i) => {
            const el = fieldEl(field);
            el.style.setProperty('--i', i); // staggered entrance
            form.appendChild(el);
        });

        const errBox = document.createElement('div');
        errBox.id = 'form-err';
        errBox.className = 'form-err';
        form.appendChild(errBox);

        const row = document.createElement('div');
        row.className = 'submit-row';
        row.innerHTML = `<button type="submit" class="submit">Count me in</button>`;
        form.appendChild(row);
    }

    // ---------- validate + submit ----------

    // Why a message per problem: at a busy booth nobody reads a generic
    // "check the form" — the field itself has to say what's wrong.
    function fieldProblem(field, v, has) {
        if (field.required && !has) {
            return field.type === 'consent'
                ? "Please tick this box so we're allowed to follow up."
                : "This one's required.";
        }
        if (!has) return null;
        if (field.type === 'tel' && String(v).replace(/\D/g, '').length < 7) {
            return 'That number looks short — mind double-checking?';
        }
        if (field.type === 'email' && !/^\S+@\S+\.\S+$/.test(String(v).trim())) {
            return "That email doesn't look complete.";
        }
        return null;
    }

    function validate() {
        let ok = true;
        let firstBad = null;
        for (const field of config.fields) {
            const v = state[field.id];
            const has = Array.isArray(v) ? v.length > 0 : v === true || (v != null && String(v).trim() !== '');
            const problem = fieldProblem(field, v, has);
            const el = form.querySelector(`.field[data-id="${field.id}"]`);
            if (problem) el.querySelector('.err').textContent = problem;
            el.classList.toggle('invalid', !!problem);
            if (problem) { ok = false; firstBad = firstBad || el; }
        }
        const errBox = $('#form-err');
        if (config.requirePhoneOrEmail && !String(state.phone || '').trim() && !String(state.email || '').trim()) {
            ok = false;
            errBox.textContent = 'We need a phone number or an email so we can reach you.';
            errBox.classList.add('show');
            firstBad = firstBad || form.querySelector('.field[data-id="phone"]');
        }
        firstBad?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return ok;
    }

    let submitting = false;
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (submitting) return; // a double-tap must not enter two leads
        if (!validate()) return;
        submitting = true;
        setTimeout(() => { submitting = false; }, 1200);

        const record = {
            id: crypto.randomUUID(),
            submittedAt: new Date().toISOString(),
            fields: Object.fromEntries(Object.entries(state)
                .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])),
        };
        const queue = loadQueue();
        queue.push(record);
        saveQueue(queue);   // durable on the iPad before anything else happens

        // Reset for the next visitor.
        for (const k of Object.keys(state)) delete state[k];
        render();
        window.scrollTo(0, 0);

        // Sync is HELD while the thank-you shows: those few seconds are the
        // staff's window to tap a lead temperature, and it has to reach the
        // server inside the same record. The iPad queue keeps it durable.
        holdFlush = true;
        const thanks = $('#thanks');
        const strip = $('#rate-strip');
        strip.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        thanks.hidden = false;
        const dismiss = () => {
            thanks.hidden = true;
            clearTimeout(t);
            holdFlush = false;
            flushQueue();
            // Back to the attract screen so the next visitor walks up to the
            // welcome, not someone else's form.
            showAttract();
        };
        const t = setTimeout(dismiss, 8000);
        thanks.addEventListener('click', (e) => {
            if (e.target.closest('.rate-strip')) return; // rating taps don't dismiss
            dismiss();
        }, { once: false });
        strip.onclick = (e) => {
            const btn = e.target.closest('button[data-rate]');
            if (!btn) return;
            strip.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
            const q = loadQueue();
            const item = q.find(x => x.id === record.id);
            if (item) { item.fields._boothRating = btn.dataset.rate; saveQueue(q); }
        };
    });

    // ---------- attract screen + idle reset ----------

    const attract = $('#attract');

    function showAttract() {
        attract.hidden = false;
        clearTimeout(idleTimer);
    }

    attract.addEventListener('click', () => {
        attract.hidden = true;
        armIdle();
        // The tap is a user gesture, so iOS allows the keyboard: first field
        // ready the moment the visitor steps up.
        form.querySelector('input')?.focus();
    });

    // Staff shortcut: tapping the status pill forces a sync attempt now.
    $('#sync-pill').addEventListener('click', flushQueue);

    // A visitor who wanders off mid-form shouldn't leave their half-typed
    // details on screen for the next person: after 90s of silence, wipe and
    // return to the welcome screen.
    let idleTimer = null;
    function armIdle() {
        clearTimeout(idleTimer);
        if (!attract.hidden) return;
        idleTimer = setTimeout(() => {
            for (const k of Object.keys(state)) delete state[k];
            render();
            window.scrollTo(0, 0);
            $('#thanks').hidden = true;
            showAttract();
        }, 90 * 1000);
    }
    for (const ev of ['pointerdown', 'input', 'touchstart']) {
        document.addEventListener(ev, armIdle, { passive: true });
    }

    // ---------- boot ----------

    async function boot() {
        try {
            const res = await fetch('/api/form');
            config = await res.json();
            localStorage.setItem('iw_form_cache', JSON.stringify(config));
        } catch {
            // Offline reload: fall back to the last form we saw so the booth
            // keeps taking names even with no server in sight.
            const cached = localStorage.getItem('iw_form_cache');
            if (!cached) {
                document.body.innerHTML = '<p style="padding:40px;font-size:20px">Can\'t reach the intake server and no cached form yet — check the wifi and reload.</p>';
                return;
            }
            config = JSON.parse(cached);
        }
        render();
        paintSyncPill();
        showAttract();
        flushQueue();
        setInterval(flushQueue, 15 * 1000);
        window.addEventListener('online', flushQueue);
        // Keep-alive: free-tier hosts sleep after ~15 idle minutes, and a
        // cold start is a ~50s stare at a blank iPad for the next visitor.
        // A tiny ping while the kiosk is open keeps the booth warm.
        setInterval(() => fetch('/api/form', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    boot();
})();
