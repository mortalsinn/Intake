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
    async function flushQueue() {
        if (syncing) return;
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
              <div class="pills"></div>
              <div class="err">Please pick one.</div>`;
            const pills = wrap.querySelector('.pills');
            for (const opt of field.options || []) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'pill';
                b.textContent = opt;
                b.addEventListener('click', () => {
                    if (field.type === 'choice') {
                        state[field.id] = state[field.id] === opt ? '' : opt;
                        for (const p of pills.children) p.classList.toggle('on', p.textContent === state[field.id]);
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
            return wrap;
        }

        const isArea = field.type === 'textarea';
        wrap.innerHTML = `
          <label class="title" for="f-${field.id}">${field.label}${field.required ? ' <span class="req">*</span>' : ''}</label>
          ${isArea
            ? `<textarea id="f-${field.id}" placeholder="${field.placeholder || ''}"></textarea>`
            : `<input id="f-${field.id}" type="${field.type}" placeholder="${field.placeholder || ''}"
                 autocapitalize="${field.autocapitalize || 'off'}" autocorrect="off" spellcheck="false"
                 ${field.type === 'email' ? 'inputmode="email"' : ''} ${field.type === 'tel' ? 'inputmode="tel"' : ''} />`}
          <div class="err">This one's required.</div>`;
        const input = wrap.querySelector('input, textarea');
        input.addEventListener('input', () => {
            state[field.id] = input.value;
            wrap.classList.remove('invalid');
            $('#form-err')?.classList.remove('show');
        });
        return wrap;
    }

    function render() {
        document.title = `${config.show.name} — Ironwood Stair & Rail`;
        $('#headline').textContent = config.show.headline || 'Tell us about your project';
        $('#subhead').textContent = config.show.subhead || '';
        $('#thanks-headline').textContent = config.show.thanks || 'Thanks!';
        $('#thanks-sub').textContent = config.show.thanksSub || '';

        form.innerHTML = '';
        for (const field of config.fields) form.appendChild(fieldEl(field));

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

    function validate() {
        let ok = true;
        let firstBad = null;
        for (const field of config.fields) {
            const v = state[field.id];
            const has = Array.isArray(v) ? v.length > 0 : v === true || (v != null && String(v).trim() !== '');
            const bad = field.required && !has;
            const el = form.querySelector(`.field[data-id="${field.id}"]`);
            el.classList.toggle('invalid', bad);
            if (bad) { ok = false; firstBad = firstBad || el; }
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

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!validate()) return;

        const record = {
            id: crypto.randomUUID(),
            submittedAt: new Date().toISOString(),
            fields: { ...state },
        };
        const queue = loadQueue();
        queue.push(record);
        saveQueue(queue);   // durable on the iPad before anything else happens
        flushQueue();

        // Reset for the next visitor.
        for (const k of Object.keys(state)) delete state[k];
        render();
        window.scrollTo(0, 0);

        const thanks = $('#thanks');
        thanks.hidden = false;
        const dismiss = () => { thanks.hidden = true; clearTimeout(t); };
        const t = setTimeout(dismiss, 6000);
        thanks.addEventListener('click', dismiss, { once: true });
    });

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
        flushQueue();
        setInterval(flushQueue, 15 * 1000);
        window.addEventListener('online', flushQueue);
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    boot();
})();
