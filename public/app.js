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
    // Everything this iPad has ever captured, kept FOREVER — never cleared
    // when a lead syncs. The queue only proves a lead left the device; if the
    // server or its disk were ever lost, the queue would be empty and the
    // leads gone with it. This is the copy that survives that.
    const ARCHIVE_KEY = 'iw_intake_archive_v1';
    const ARCHIVE_MAX = 2000;   // far beyond a show; guards the storage quota

    let config = null;
    // 'enquiry' (the project form), 'contest' (the prize draw) or 'ribit'
    // (a Code Compass demo request). All use the same renderer, queue,
    // archive and server pipeline; only the spec and where the entry is
    // filed differ.
    let kind = 'enquiry';
    // The two companies sharing this iPad. Loaded from /api/brands; a kiosk
    // with no brands.json simply runs single-brand exactly as before.
    let brands = null;
    let brand = null;
    const state = {}; // fieldId -> value

    const $ = (sel) => document.querySelector(sel);
    const form = $('#lead-form');

    // ---------- local queue ----------

    const loadQueue = () => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    const saveQueue = (q) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    const loadDead = () => JSON.parse(localStorage.getItem(DEAD_KEY) || '[]');
    const loadArchive = () => JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');

    /** Keep a permanent copy on the device. Never removed by syncing. */
    function archive(record) {
        try {
            const all = loadArchive();
            if (all.some(r => r.id === record.id)) return;
            all.push({ ...record, archivedAt: new Date().toISOString() });
            localStorage.setItem(ARCHIVE_KEY, JSON.stringify(all.slice(-ARCHIVE_MAX)));
        } catch (err) {
            // Storage full is survivable — the server copy is the primary —
            // but staff should know this safety net has stopped working.
            console.error('archive write failed', err);
        }
    }

    /** The device's own copy, as a spreadsheet, with no network at all. */
    function exportArchive() {
        const rows = loadArchive();
        if (!rows.length) return alert('Nothing captured on this device yet.');
        const keys = [...new Set(rows.flatMap(r => Object.keys(r.fields || {})))]
            .filter(k => !k.startsWith('_'));
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [
            ['capturedAt', ...keys, 'priority', 'inspiration'].map(esc).join(','),
            ...rows.map(r => [
                r.submittedAt,
                ...keys.map(k => {
                    const v = r.fields?.[k];
                    return Array.isArray(v) ? v.join('; ') : v ?? '';
                }),
                r.fields?._boothRating || '',
                (r.fields?._inspiration || []).join('; '),
            ].map(esc).join(',')),
        ].join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = `intake-device-copy-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

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
                        const body = await res.json().catch(() => ({}));
                        // The server owns the upload token, so the QR can only
                        // be drawn once the lead has actually reached it.
                        if (body.uploadUrl) showQr(body.uploadUrl);
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
            pollStatus(); // repaints with fresh server truth
        }
    }

    // Last known SERVER state. The iPad's own queue only proves a lead left
    // the iPad; this proves it reached Zoho.
    let serverStatus = null;

    async function pollStatus() {
        try {
            serverStatus = await (await fetch('/api/status', { cache: 'no-store' })).json();
        } catch {
            serverStatus = null; // offline; the queue message covers it
        }
        paintSyncPill();
    }

    function paintSyncPill() {
        const pill = $('#sync-pill');
        const waiting = loadQueue().length;
        const dead = loadDead().length;

        // Two audiences, two amounts of detail.
        //
        // On the welcome screen, staff get the full picture — counts,
        // warnings, whether Zoho is accepting leads.
        //
        // While a customer is filling the form they get CONNECTION only, no
        // counts: how many enquiries the booth has taken is the shop's
        // business, not theirs. It stays deliberately quiet when all is well
        // and only speaks up when the booth has dropped offline — which
        // changes nothing about safety, but is worth staff knowing.
        const onWelcome = !$('#attract')?.hidden || !$('#splash')?.hidden;
        pill.hidden = false;

        if (!onWelcome) {
            const offline = !navigator.onLine || serverStatus === null;
            pill.textContent = offline
                ? 'Offline — saving on this device'
                : 'Online';
            pill.className = offline ? 'sync-pill dead' : 'sync-pill quiet';
            return;
        }

        // Worst news first — a booth glance must surface the real problem.
        if (dead) {
            pill.textContent = `${dead} entries require attention — see admin`;
            pill.className = 'sync-pill dead';
        } else if (serverStatus && !serverStatus.zohoConnected) {
            const held = serverStatus.counts.total;
            pill.textContent = `⚠ Zoho not connected${held ? ` — ${held} entries held securely` : ''}`;
            pill.className = 'sync-pill dead';
        } else if (serverStatus && serverStatus.zohoConnected && !serverStatus.zohoNotes) {
            // Leads are landing, but their booth detail is not — worth saying
            // out loud, because the leads themselves look perfectly healthy.
            pill.textContent = '⚠ Leads received, notes blocked — see admin';
            pill.className = 'sync-pill dead';
        } else if (serverStatus && serverStatus.counts.failed) {
            pill.textContent = `${serverStatus.counts.failed} declined by Zoho — see admin`;
            pill.className = 'sync-pill dead';
        } else if (waiting) {
            pill.textContent = `${waiting} saved on this device — awaiting connection`;
            pill.className = 'sync-pill wait';
        } else if (serverStatus && serverStatus.counts.pending) {
            pill.textContent = `${serverStatus.counts.pending} awaiting transfer to Zoho`;
            pill.className = 'sync-pill wait';
        } else if (serverStatus && serverStatus.counts.synced) {
            pill.textContent = `${serverStatus.counts.synced} recorded in Zoho`;
            pill.className = 'sync-pill ok';
        } else {
            pill.textContent = serverStatus ? 'Ready' : 'Offline — entries are saved on this device';
            pill.className = serverStatus ? 'sync-pill ok' : 'sync-pill wait';
        }
    }

    // ---------- rendering ----------

    function fieldEl(field) {
        const wrap = document.createElement('div');
        wrap.className = `field${field.half ? ' half' : ''}`;
        wrap.dataset.id = field.id;

        if (field.type === 'consent') {
            // The fine print sits with the tickbox on purpose: consent to
            // marketing has to identify who is asking, how to reach them and
            // how to withdraw it — beside the box, not buried in a footer.
            const fine = config.consentFinePrint
                ? `<p class="fine-print">${config.consentFinePrint}</p>` : '';
            wrap.innerHTML = `
              <div class="consent-row" role="checkbox" aria-checked="false" tabindex="0">
                <div class="box">✓</div><span class="txt">${field.label}</span>
              </div>
              ${fine}
              <div class="err">Please confirm consent so that we may contact you.</div>`;
            const row = wrap.querySelector('.consent-row');
            row.addEventListener('click', () => {
                state[field.id] = !state[field.id];
                row.classList.toggle('on', !!state[field.id]);
                row.setAttribute('aria-checked', String(!!state[field.id]));
                wrap.classList.remove('invalid');
            });
            return wrap;
        }

        if (field.type === 'inspiration') {
            wrap.innerHTML = `
              <label class="title">${field.label}</label>
              <button type="button" class="inspo-btn" id="inspiration-open">${field.buttonLabel || 'Browse the Inspiration Gallery'}</button>
              <div class="inspo-picks" id="inspiration-picks"></div>`;
            wrap.querySelector('#inspiration-open').addEventListener('click', openGallery);
            // Re-render picks in case the visitor already chose some and the
            // form was rebuilt underneath them.
            setTimeout(paintInspirationField, 0);
            return wrap;
        }

        if (field.type === 'choice' || field.type === 'multi') {
            // A multi-select looks identical to a single-select until you try
            // a second tap, so say plainly that more than one is allowed.
            const hint = field.hint
                ? `<span class="field-hint">${field.hint}</span>`
                : (field.type === 'multi' ? '<span class="field-hint">Choose as many as you like</span>' : '');
            wrap.innerHTML = `
              <label class="title">${field.label}${field.required ? ' <span class="req">*</span>' : ''}${hint}</label>
              <div class="err">Please select an option.</div>`;
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
        const textHint = field.hint ? `<span class="field-hint">${field.hint}</span>` : '';
        wrap.innerHTML = `
          <label class="title" for="f-${field.id}">${field.label}${field.required ? ' <span class="req">*</span>' : ''}${textHint}</label>
          ${isArea
            ? `<textarea id="f-${field.id}" placeholder="${field.placeholder || ''}" autocomplete="off"></textarea>`
            : `<input id="f-${field.id}" type="${field.type}" placeholder="${field.placeholder || ''}"
                 autocomplete="do-not-autofill-${field.id}" data-lpignore="true"
                 autocapitalize="${field.autocapitalize || 'off'}" autocorrect="off" spellcheck="false"
                 ${field.type === 'email' ? 'inputmode="email"' : ''} ${field.type === 'tel' ? 'inputmode="tel" maxlength="16"' : ''} />`}
          <div class="err">This one's required.</div>`;
        const input = wrap.querySelector('input, textarea');

        // A default that is right for nearly everyone saves a keystroke and
        // still lets the odd out-of-province visitor change it.
        if (field.default && !state[field.id]) {
            input.value = field.default;
            state[field.id] = field.default;
        } else if (state[field.id]) {
            input.value = state[field.id];   // survives a step change
        }

        input.addEventListener('input', (e) => {
            if (field.format === 'postal') {
                let v = input.value;
                if (e.inputType === 'deleteContentBackward' && /\s$/.test(v)) v = v.trim().slice(0, -1);
                input.value = formatPostal(v);
            }
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

    /** T2E 7Z8 — uppercase, single space, as they type. */
    function formatPostal(raw) {
        const c = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        return c.length > 3 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
    }

    // Uppercase the first letter of each word; never lowercase what's there,
    // so "McLean" typed correctly stays "McLean".
    const capWords = (s) => s.replace(/(^|[\s\-'])(\p{Ll})/gu, (m, p, c) => p + c.toUpperCase());

    function render() {
        document.title = `${config.show.name} — ${brand?.name || config.company?.name || 'Ironwood Stair & Rail'}`;
        $('#headline').textContent = config.show.headline || 'Tell us about your project';
        $('#subhead').textContent = config.show.subhead || '';
        $('#thanks-headline').textContent = config.show.thanks || 'Thanks!';
        $('#thanks-sub').textContent = config.show.thanksSub || '';
        if (config.show.attractLine) $('#attract-line').textContent = config.show.attractLine;

        form.innerHTML = '';
        // Section headers break twelve questions into three small asks. The
        // number matters more than it looks: it tells someone mid-form how
        // much is left, which is the thing a long column never says.
        let lastSection = null;
        let sectionNo = 0;
        config.fields.forEach((field, i) => {
            if (field.section && field.section !== lastSection) {
                lastSection = field.section;
                sectionNo++;
                const head = document.createElement('div');
                head.className = 'section-head';
                head.dataset.section = field.section;
                head.style.setProperty('--i', i);
                head.innerHTML = `<span class="section-num">${sectionNo}</span>
                                  <span class="section-title">${field.section}</span>`;
                form.appendChild(head);
            }
            const el = fieldEl(field);
            el.style.setProperty('--i', i); // staggered entrance
            form.appendChild(el);
        });

        const errBox = document.createElement('div');
        errBox.id = 'form-err';
        errBox.className = 'form-err';
        form.appendChild(errBox);

        buildSteps();
        showStep(0);
    }

    // ---------- steps ----------

    // Twelve questions in one column reads as an endless list however well it
    // is spaced. The same questions across three short screens read as three
    // small asks, and each screen is visibly finishable.
    let stepNames = [];
    let currentStep = 0;

    function buildSteps() {
        stepNames = [];
        for (const f of config.fields) {
            if (f.section && !stepNames.includes(f.section)) stepNames.push(f.section);
        }
        const bar = $('#steps');
        bar.innerHTML = stepNames.map((name, i) =>
            `<span class="step-pip" data-i="${i}"><i>${i + 1}</i>${name}</span>`).join('');
    }

    function showStep(i) {
        currentStep = Math.max(0, Math.min(i, stepNames.length - 1));
        const name = stepNames[currentStep];

        for (const el of form.querySelectorAll('.field, .section-head')) {
            const owner = el.classList.contains('section-head')
                ? el.dataset.section
                : (config.fields.find(f => f.id === el.dataset.id) || {}).section;
            // Section headings are redundant once the step itself is titled.
            el.hidden = el.classList.contains('section-head') || owner !== name;
        }

        for (const pip of $('#steps').children) {
            const n = Number(pip.dataset.i);
            pip.classList.toggle('on', n === currentStep);
            pip.classList.toggle('done', n < currentStep);
        }

        $('#step-back').hidden = currentStep === 0;
        $('#step-next').textContent = currentStep === stepNames.length - 1
            ? (config.show.submitLabel || 'Submit')
            : 'Continue';
        $('#form-err')?.classList.remove('show');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /** Only the fields on this step — a visitor must not be told about
     *  something they have not been shown yet. */
    const fieldsOnStep = () => config.fields.filter(f => f.section === stepNames[currentStep]);

    $('#step-back').addEventListener('click', () => showStep(currentStep - 1));
    $('#step-next').addEventListener('click', () => {
        if (!validate(fieldsOnStep())) return;
        if (currentStep < stepNames.length - 1) showStep(currentStep + 1);
        else form.requestSubmit();
    });

    // ---------- validate + submit ----------

    // Why a message per problem: at a busy booth nobody reads a generic
    // "check the form" — the field itself has to say what's wrong.
    function fieldProblem(field, v, has) {
        if (field.required && !has) {
            return field.type === 'consent'
                ? "Please confirm consent so that we may contact you."
                : "This field is required.";
        }
        if (!has) return null;
        if (field.type === 'tel' && String(v).replace(/\D/g, '').length < 7) {
            return 'That number appears incomplete — please check it.';
        }
        if (field.type === 'email' && !/^\S+@\S+\.\S+$/.test(String(v).trim())) {
            return "That email address appears incomplete.";
        }
        if (field.format === 'postal' && !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(String(v).trim())) {
            return 'That postal code looks incomplete — six characters, like T2E 7Z8.';
        }
        return null;
    }

    function validate(fields = config.fields) {
        let ok = true;
        let firstBad = null;
        for (const field of fields) {
            const v = state[field.id];
            const has = Array.isArray(v) ? v.length > 0 : v === true || (v != null && String(v).trim() !== '');
            const problem = fieldProblem(field, v, has);
            const el = form.querySelector(`.field[data-id="${field.id}"]`);
            if (problem) el.querySelector('.err').textContent = problem;
            el.classList.toggle('invalid', !!problem);
            if (problem) { ok = false; firstBad = firstBad || el; }
        }
        const errBox = $('#form-err');
        const checksContact = fields.some(f => f.id === 'phone' || f.id === 'email');
        if (checksContact && config.requirePhoneOrEmail
            && !String(state.phone || '').trim() && !String(state.email || '').trim()) {
            ok = false;
            errBox.textContent = 'Please provide a phone number or an email address so we can reach you.';
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
            kind,
            submittedAt: new Date().toISOString(),
            fields: Object.fromEntries(Object.entries(state)
                .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])),
        };
        const queue = loadQueue();
        queue.push(record);
        saveQueue(queue);   // durable on the iPad before anything else happens
        archive(record);    // and permanently, whatever happens to it later

        // Reset for the next visitor.
        for (const k of Object.keys(state)) delete state[k];
        render();
        window.scrollTo(0, 0);

        // Sent straight away: the QR code needs the server's upload token, so
        // the lead has to arrive before the thank-you card can be useful. The
        // server holds the Zoho push briefly so a priority tap still catches
        // the same record — see holdUntil in server.js.
        flushQueue();

        // Naming the visitor on the staff step matters at a busy booth: two
        // enquiries can stack up, and "How should Dana be followed up?" is
        // unambiguous where "this enquiry" is not.
        const name = [record.fields.firstName, record.fields.lastName]
            .filter(Boolean).join(' ').trim();

        // Three screens, each waiting for a tap rather than a clock:
        //   QR  ->  Thank you  ->  staff priority  ->  welcome
        // The safety timeouts below exist only so an abandoned iPad returns
        // to the welcome screen; they are far longer than anyone needs.
        // A draw entry has no project photographs to send, so it goes
        // straight to the thank you.
        if (kind === 'contest') showThanksStep(record.id, name);
        else showQrStep(record.id, name);
    });

    // ---------- inspiration gallery ----------

    const MAX_INSPIRATION = 3;
    let galleryData = null;      // { filters, photos } from config/gallery.json
    let activeFilter = null;     // null = show everything

    /** Photographs the visitor picked, in the order they picked them. */
    const chosenInspiration = () => state._inspiration || (state._inspiration = []);

    async function openGallery() {
        const overlay = $('#gallery');
        if (!galleryData) {
            try {
                galleryData = await (await fetch('/api/gallery')).json();
            } catch {
                return; // no gallery configured; the button is hidden anyway
            }
            paintFilters();
        }
        // Show FIRST, then paint: the column count is measured from the
        // grid's width, and a hidden element measures zero — which silently
        // collapsed the gallery to the narrowest layout.
        overlay.hidden = false;
        paintGrid();
    }

    // Rebalance when the iPad is turned.
    window.addEventListener('resize', () => {
        if (!$('#gallery').hidden && galleryData) paintGrid();
    });

    function paintFilters() {
        const bar = $('#gallery-filters');
        bar.innerHTML = '';
        const chip = (label, value) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'g-chip' + (activeFilter === value ? ' on' : '');
            b.textContent = label;
            b.addEventListener('click', () => { activeFilter = value; paintFilters(); paintGrid(); });
            bar.appendChild(b);
        };
        chip('All', null);
        for (const f of galleryData.filters || []) chip(f.label, f.match);
    }

    function visiblePhotos() {
        const all = galleryData.photos || [];
        return activeFilter ? all.filter(p => (p.tags || []).includes(activeFilter)) : all;
    }

    function paintGrid() {
        const grid = $('#gallery-grid');
        const picked = chosenInspiration();
        grid.innerHTML = '';

        // Real column elements rather than CSS `columns`. Multi-column fills
        // downward then starts a NEW column sideways, so inside a fixed-height
        // scroller it overflows horizontally — the grid grew a sideways
        // scrollbar and clipped a column. Columns as flex children scroll the
        // way a gallery should.
        const colCount = grid.clientWidth > 1100 ? 4 : grid.clientWidth > 700 ? 3 : 2;
        const cols = [];
        for (let i = 0; i < colCount; i++) {
            const c = document.createElement('div');
            c.className = 'g-col';
            grid.appendChild(c);
            cols.push({ el: c, height: 0 });
        }
        // Drop each photograph into whichever column is currently shortest,
        // so the bottom edge stays roughly level instead of one long tail.
        const shortest = () => cols.reduce((a, b) => (b.height < a.height ? b : a));

        for (const photo of visiblePhotos()) {
            const idx = picked.indexOf(photo.id);
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'g-cell' + (idx >= 0 ? ' on' : '');
            cell.innerHTML = `
              <img src="${photo.thumb}" alt="${(photo.alt || '').replace(/"/g, '&quot;')}" loading="lazy" />
              <span class="g-tick">${idx >= 0 ? idx + 1 : ''}</span>
              <span class="g-zoom" aria-label="View full screen">⤢</span>`;
            cell.addEventListener('click', (e) => {
                // Two intents on one tile, so they get separate targets: the
                // corner glass opens the big view, the photo itself picks it.
                if (e.target.closest('.g-zoom')) openLightbox(photo.id);
                else toggleInspiration(photo.id);
            });
            const col = shortest();
            col.el.appendChild(cell);
            // Aspect ratio from the manifest would be ideal; these are all
            // roughly portrait, so a constant keeps the columns balanced
            // without waiting for images to load.
            col.height += 1;
        }
        paintCount();
    }

    function toggleInspiration(id) {
        const picked = chosenInspiration();
        const at = picked.indexOf(id);
        if (at >= 0) picked.splice(at, 1);
        else if (picked.length < MAX_INSPIRATION) picked.push(id);
        else {
            // At the limit, swap the oldest out rather than refusing the tap.
            // A visitor who keeps tapping should keep seeing something happen.
            picked.shift();
            picked.push(id);
        }
        paintGrid();
        paintInspirationField();
    }

    function paintCount() {
        const n = chosenInspiration().length;
        $('#gallery-count').textContent = n === 0
            ? `Choose up to ${MAX_INSPIRATION} photographs you like`
            : `${n} of ${MAX_INSPIRATION} chosen — tap again to remove`;
    }

    /** Thumbnails of the picks, shown inline on the form. */
    function paintInspirationField() {
        const holder = $('#inspiration-picks');
        if (!holder || !galleryData) return;
        const picked = chosenInspiration();
        holder.innerHTML = picked.map(id => {
            const p = galleryData.photos.find(x => x.id === id);
            return p ? `<img src="${p.thumb}" alt="" />` : '';
        }).join('');
        const btn = $('#inspiration-open');
        if (btn) {
            btn.textContent = picked.length
                ? `${picked.length} chosen — change`
                : 'Browse the Inspiration Gallery';
        }
    }

    // ---------- full-screen viewer ----------

    let lightboxAt = -1;   // index within the CURRENT filter, so arrows respect it

    function openLightbox(id) {
        const list = visiblePhotos();
        lightboxAt = list.findIndex(p => p.id === id);
        if (lightboxAt < 0) return;
        paintLightbox();
        $('#lightbox').hidden = false;
    }

    function paintLightbox() {
        const list = visiblePhotos();
        const photo = list[lightboxAt];
        if (!photo) return;
        const img = $('#lb-img');
        // Show the cached thumbnail instantly, then swap in the full-size
        // image from the website once it arrives — no blank screen while a
        // 500KB photograph loads over show wifi.
        img.src = photo.thumb;
        const full = new Image();
        full.onload = () => { if (visiblePhotos()[lightboxAt]?.id === photo.id) img.src = full.src; };
        full.src = photo.full;

        img.alt = photo.alt || '';
        $('#lb-alt').textContent = photo.alt || '';
        $('#lb-prev').hidden = lightboxAt === 0;
        $('#lb-next').hidden = lightboxAt >= list.length - 1;

        const picked = chosenInspiration().includes(photo.id);
        const btn = $('#lb-pick');
        btn.textContent = picked ? '✓ Selected — tap to remove' : 'Select this photograph';
        btn.classList.toggle('on', picked);
    }

    const closeLightbox = () => { $('#lightbox').hidden = true; };

    $('#lb-close').addEventListener('click', closeLightbox);
    $('#lightbox').addEventListener('click', (e) => {
        // Tapping the backdrop closes; taps on the image or controls do not.
        if (e.target.id === 'lightbox') closeLightbox();
    });
    $('#lb-prev').addEventListener('click', () => { lightboxAt--; paintLightbox(); });
    $('#lb-next').addEventListener('click', () => { lightboxAt++; paintLightbox(); });
    $('#lb-pick').addEventListener('click', () => {
        const photo = visiblePhotos()[lightboxAt];
        if (!photo) return;
        toggleInspiration(photo.id);
        paintLightbox();
    });

    $('#gallery-done').addEventListener('click', () => { $('#gallery').hidden = true; });

    // ---------- after submitting: QR, thank you, staff ----------

    // Generous. Nobody should be hurried while fishing a phone out of a
    // pocket; these only exist so an abandoned booth finds its way home.
    const QR_BAIL_MS = 5 * 60 * 1000;
    const THANKS_BAIL_MS = 2 * 60 * 1000;

    /** Step 1: the QR, on its own, going nowhere until it is tapped. */
    async function showQrStep(leadId, who) {
        const panel = $('#qr-step');
        if (!panel) return showThanksStep(leadId, who);

        // Give the code a moment to arrive. Offline, or a failure drawing it,
        // means there is nothing to scan — so skip to the thank you rather
        // than presenting an empty box.
        const ready = await awaitQr(5000);
        if (!ready) return showThanksStep(leadId, who);

        const done = () => {
            clearTimeout(bail);
            panel.onclick = null;
            panel.hidden = true;
            showThanksStep(leadId, who);
        };
        const bail = setTimeout(() => {
            clearTimeout(bail);
            panel.onclick = null;
            panel.hidden = true;
            clearQr();
            showSplash();   // nobody there; do not leave a QR on screen
        }, QR_BAIL_MS);

        panel.onclick = done;
        panel.hidden = false;
    }

    /** Step 2: the goodbye. Also waits to be tapped. */
    function showThanksStep(leadId, who) {
        const panel = $('#thanks');
        clearQr();
        const done = () => {
            clearTimeout(bail);
            panel.onclick = null;
            panel.hidden = true;
            askPriority(leadId, who);
        };
        const bail = setTimeout(() => {
            clearTimeout(bail);
            panel.onclick = null;
            panel.hidden = true;
            showSplash();   // nobody tapped, so nobody is holding it
        }, THANKS_BAIL_MS);
        panel.onclick = done;
        panel.hidden = false;
    }

    // ---------- staff step: enquiry priority ----------

    /**
     * Ask staff to prioritise the enquiry that just came in.
     *
     * Shown only after a deliberate tap on the thank-you card, which in a
     * booth is the moment the tablet is handed back — so the visitor never
     * watches themselves being ranked. Skipping is a first-class option:
     * at a busy booth an unanswered prompt must not block the next visitor.
     */
    function askPriority(leadId, who) {
        const step = $('#staff-step');
        if (!step) { showSplash(); return; }
        $('#staff-who').textContent = who
            ? `How should ${who} be followed up?`
            : 'How should this enquiry be followed up?';

        const finish = () => {
            clearTimeout(bail);
            step.onclick = null;
            step.hidden = true;
            showSplash();
        };
        // If staff walk off mid-prompt, do not strand the booth on an
        // internal screen — fall back to the welcome.
        const bail = setTimeout(finish, 25000);

        step.onclick = (e) => {
            const btn = e.target.closest('button[data-rate]');
            if (btn) {
                // Straight to the server: the lead has already been sent, so
                // the priority catches up with it there, not in the queue.
                // Update the device's permanent copy as well, or its record of
            // this enquiry would be missing the priority forever.
            try {
                const all = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
                const row = all.find(r => r.id === leadId);
                if (row) {
                    row.fields = { ...row.fields, _boothRating: btn.dataset.rate };
                    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(all));
                }
            } catch { /* the server copy is primary */ }
            fetch(`/api/leads/${encodeURIComponent(leadId)}/priority`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ priority: btn.dataset.rate }),
                }).catch(() => { /* the lead is already safe; priority is a bonus */ });
                finish();
                return;
            }
            if (e.target.closest('#staff-skip')) finish();
        };
        step.hidden = false;
    }

    // ---------- photograph QR ----------

    /**
     * Draw the QR for the lead just submitted.
     *
     * Only shown while the thank-you card is up, and cleared with it — the
     * next visitor must never be handed the previous customer's link.
     */
    // The QR is drawn only after the server answers with an upload token,
    // which happens after the submit handler has already moved on. Without
    // something to wait on, the QR step looked at an empty frame every time
    // and skipped itself.
    let qrDrawn = null;
    const awaitQr = (ms) => new Promise((resolve) => {
        if ($('#qr-frame')?.innerHTML.startsWith('<svg')) return resolve(true);
        qrDrawn = resolve;
        setTimeout(() => resolve(false), ms);
    });

    async function showQr(url) {
        const frame = $('#qr-frame');
        if (!frame) return;
        try {
            const svg = await (await fetch(`/api/qr?url=${encodeURIComponent(url)}`)).text();
            if (!svg.startsWith('<svg')) throw new Error('bad qr');
            frame.innerHTML = svg;   // the QR SCREEN is shown by showQrStep
            if (qrDrawn) { qrDrawn(true); qrDrawn = null; }
        } catch {
            frame.innerHTML = '';    // no QR beats a broken one
            if (qrDrawn) { qrDrawn(false); qrDrawn = null; }
        }
    }

    function clearQr() {
        const frame = $('#qr-frame');
        if (frame) frame.innerHTML = '';
    }

    // ---------- brands ----------

    async function loadBrands() {
        try {
            const res = await fetch('/api/brands');
            if (!res.ok) throw new Error('none');
            brands = await res.json();
            localStorage.setItem('iw_brands_cache', JSON.stringify(brands));
        } catch {
            // Same rule as the form spec: a booth with no server still opens.
            const cached = localStorage.getItem('iw_brands_cache');
            brands = cached ? JSON.parse(cached) : null;
        }
        const list = brands?.brands || [];
        return list.length > 1 ? list : null;
    }

    const brandById = (id) => (brands?.brands || []).find(b => b.id === id) || null;

    /** Paint the chooser from config, so adding a third booth is a JSON edit. */
    function paintSplash() {
        const sp = brands?.splash || {};
        $('#splash-headline').textContent = sp.headline || 'Welcome';
        $('#splash-sub').textContent = sp.subhead || '';
        $('#splash-foot').textContent = sp.footNote || '';
        const grid = $('#splash-grid');
        grid.innerHTML = '';
        for (const b of brands.brands) {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'splash-card';
            card.dataset.chooseBrand = b.id;
            // Theme the card with its OWN brand, not the one currently
            // loaded — the chooser has to show both companies at once.
            card.dataset.theme = b.id;
            const logo = document.createElement('img');
            logo.src = b.cardLogo || b.logo;
            logo.alt = b.logoAlt || b.name;
            logo.className = 'splash-logo';
            const tag = document.createElement('p');
            tag.className = 'splash-tag';
            tag.textContent = b.tagline || '';
            const blurb = document.createElement('p');
            blurb.className = 'splash-blurb';
            blurb.textContent = b.blurb || '';
            const go = document.createElement('span');
            go.className = 'splash-go';
            go.textContent = 'Choose';
            card.append(logo, tag, blurb, go);
            grid.appendChild(card);
        }
    }

    /**
     * Switch the whole kiosk to a brand: its theme, its attract screen, its
     * form spec. Always clears half-typed answers — carrying an Ironwood
     * address into a Ribit demo request is exactly the mix-up the separate
     * chooser screen exists to prevent.
     */
    async function useBrand(id) {
        brand = brandById(id) || brand;
        if (!brand) return;
        document.documentElement.dataset.brand = brand.id;
        for (const k of Object.keys(state)) delete state[k];
        kind = brand.ctas?.[0]?.kind || 'enquiry';
        await loadConfig();
        paintBrandChrome();
        render();
    }

    /** Everything on the attract screen and masthead that a brand owns. */
    function paintBrandChrome() {
        if (!brand) return;
        const logo = $('#attract-logo');
        if (logo) { logo.src = brand.logo; logo.alt = brand.logoAlt || brand.name; }
        const wide = $('#brand-wide');
        if (wide) { wide.src = brand.logo; wide.alt = brand.logoAlt || brand.name; }
        // Awards and the stair illustration are Ironwood's, not the platform's.
        for (const el of document.querySelectorAll('[data-awards]')) el.hidden = !brand.awards;
        // setAttribute, NOT .hidden. The stair is an <svg>, and SVGElement
        // does not reflect the hidden IDL property to the content attribute
        // the way HTMLElement does — `rail.hidden = true` sets a plain JS
        // property, the attribute never appears, and the CSS rule that hides
        // it never matches. It stayed on screen behind the Ribit branding.
        const rail = $('#attract-rail');
        if (rail) {
            if (brand.rail) rail.removeAttribute('hidden');
            else rail.setAttribute('hidden', '');
        }

        const choices = $('#attract-choices');
        if (choices) {
            choices.innerHTML = '';
            for (const cta of brand.ctas || []) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = `attract-cta${cta.secondary ? ' secondary' : ''}`;
                b.dataset.kind = cta.kind;
                b.textContent = cta.label;
                choices.appendChild(b);
            }
        }
        const sw = $('#attract-switch');
        if (sw) {
            const other = (brands?.brands || []).filter(b => b.id !== brand.id);
            sw.hidden = !other.length;
            sw.textContent = other.length === 1
                ? `Here for ${other[0].name} instead?`
                : 'Here for something else?';
        }
    }

    // ---------- attract screen + idle reset ----------

    const attract = $('#attract');
    const splash = $('#splash');

    /** Back to the chooser: a fresh visitor, either company, nothing carried. */
    function showSplash() {
        if (!splash || !brands?.brands?.length) return showAttract();
        for (const k of Object.keys(state)) delete state[k];
        clearTimeout(idleTimer);
        attract.hidden = true;
        splash.hidden = false;
        paintSyncPill();
    }

    splash?.addEventListener('click', async (e) => {
        const id = e.target.closest('[data-choose-brand]')?.dataset.chooseBrand;
        if (!id) return;
        await useBrand(id);
        splash.hidden = true;
        showAttract();
    });

    function showAttract() {
        if (splash) splash.hidden = true;
        attract.hidden = false;
        clearTimeout(idleTimer);
        paintSyncPill();
    }

    attract.addEventListener('click', async (e) => {
        // The way back to the other company, before any form is touched.
        if (e.target.closest('#attract-switch')) return showSplash();
        const chosen = e.target.closest('[data-kind]')?.dataset.kind;
        // Switching forms reloads the spec and clears anything half-typed —
        // a draw entry must never inherit answers from an abandoned enquiry.
        if (chosen && chosen !== kind) {
            kind = chosen;
            for (const k of Object.keys(state)) delete state[k];
            await loadConfig();
            render();
        }
        attract.hidden = true;
        paintSyncPill();      // hides it the moment the form appears
        armIdle();
        // The tap is a user gesture, so iOS allows the keyboard: first field
        // ready the moment the visitor steps up.
        form.querySelector('input')?.focus();
    });

    // Staff shortcut: tapping the status pill forces a sync attempt now.
    $('#sync-pill').addEventListener('click', () => { flushQueue(); pollStatus(); });

    // ---------- start over ----------

    /** Is there anything a visitor would be sad to lose? */
    const formHasContent = () => Object.values(state).some(v =>
        Array.isArray(v) ? v.length > 0 : v === true || (v != null && String(v).trim() !== ''));

    function clearForm() {
        for (const k of Object.keys(state)) delete state[k];
        render();
        window.scrollTo(0, 0);
        $('#thanks').hidden = true;
        showSplash();
    }

    const resetBtn = $('#reset-btn');
    let armedTimer = null;
    const disarm = () => {
        clearTimeout(armedTimer);
        armedTimer = null;
        resetBtn.classList.remove('armed');
        resetBtn.textContent = '↺ Start over';
    };

    resetBtn.addEventListener('click', () => {
        // Nothing typed yet: no confirmation to give, just go home.
        if (!formHasContent()) { clearForm(); return; }
        // Something IS typed. One stray tap must not wipe a visitor's work,
        // but staff must not be slowed by a modal either — so the button
        // arms itself and the second tap commits. Auto-disarms in 4s.
        if (armedTimer) { disarm(); clearForm(); return; }
        resetBtn.classList.add('armed');
        resetBtn.textContent = 'Tap again to clear';
        armedTimer = setTimeout(disarm, 4000);
    });

    // A visitor who wanders off mid-form shouldn't leave their half-typed
    // details on screen for the next person: after 90s of silence, wipe and
    // return to the welcome screen.
    let idleTimer = null;
    // Long, because a staff member sitting with a customer and talking may
    // not touch the screen for a while. Privacy still gets its way — but by
    // asking first, not by deciding on its own.
    const IDLE_MS = 5 * 60 * 1000;
    const IDLE_GRACE_S = 30;

    /**
     * Is the visitor busy looking at something, rather than gone?
     *
     * Someone studying the gallery, reading a photograph full screen, or
     * still on the thank-you card is present — they simply are not touching
     * the glass. Wiping their half-filled form out from under them because
     * they spent two minutes choosing a railing is the single worst thing
     * this kiosk could do, and it took no touching at all to trigger.
     */
    const visitorIsEngaged = () =>
        !$('#gallery').hidden || !$('#lightbox').hidden
        || !$('#thanks').hidden || !$('#staff-step').hidden || !$('#qr-step').hidden;

    /** Has anyone actually typed anything worth protecting? */
    const formHasAnswers = () => Object.values(state).some(v =>
        Array.isArray(v) ? v.length > 0 : v === true || (v != null && String(v).trim() !== ''));

    let graceTimer = null;

    function wipeAndGoHome() {
        clearTimeout(graceTimer);
        $('#idle-check').hidden = true;
        for (const k of Object.keys(state)) delete state[k];
        render();
        window.scrollTo(0, 0);
        $('#thanks').hidden = true;
        showSplash();
    }

    /**
     * Ask before clearing.
     *
     * The old behaviour simply wiped the form, which is fine for a kiosk
     * nobody is standing at and awful when a staff member is sitting beside
     * a customer working through it — a pause in the conversation cost them
     * everything typed so far. An empty form still resets silently: there is
     * nothing to protect and nothing to interrupt.
     */
    function askBeforeClearing() {
        if (!formHasAnswers()) return wipeAndGoHome();

        const panel = $('#idle-check');
        const countEl = $('#idle-count');
        let left = IDLE_GRACE_S;
        countEl.textContent = left;
        panel.hidden = false;

        clearTimeout(graceTimer);
        const tick = () => {
            left -= 1;
            countEl.textContent = Math.max(0, left);
            if (left <= 0) return wipeAndGoHome();
            graceTimer = setTimeout(tick, 1000);
        };
        graceTimer = setTimeout(tick, 1000);
    }

    function keepGoing() {
        clearTimeout(graceTimer);
        $('#idle-check').hidden = true;
        armIdle();
    }

    // DEMO ONLY — fires the idle prompt on demand so it can be shown off
    // without waiting five minutes. Delete this block and the button in
    // index.html when it is no longer wanted.
    $('#demo-idle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(idleTimer);
        askBeforeClearing();
    });

    $('#idle-keep').addEventListener('click', keepGoing);
    $('#idle-clear').addEventListener('click', wipeAndGoHome);

    function armIdle() {
        clearTimeout(idleTimer);
        if (!attract.hidden || !$('#splash')?.hidden) return;
        idleTimer = setTimeout(() => {
            // Re-check at the moment it fires, not when it was armed.
            if (visitorIsEngaged()) return armIdle();
            askBeforeClearing();
        }, IDLE_MS);
    }
    for (const ev of ['pointerdown', 'input', 'touchstart', 'scroll']) {
        document.addEventListener(ev, () => {
            // Any touch while the prompt is up answers it: they are here.
            if (!$('#idle-check').hidden) return keepGoing();
            armIdle();
        }, { passive: true, capture: true });
    }

    // ---------- boot ----------

    /** Fetch the spec for the current kind, falling back to a cached copy. */
    async function loadConfig() {
        try {
            const res = await fetch(`/api/form?kind=${encodeURIComponent(kind)}`);
            config = await res.json();
            localStorage.setItem(`iw_form_cache_${kind}`, JSON.stringify(config));
            return true;
        } catch {
            // Offline reload: fall back to the last form we saw so the booth
            // keeps taking names even with no server in sight.
            const cached = localStorage.getItem(`iw_form_cache_${kind}`);
            if (!cached) return false;
            config = JSON.parse(cached);
            return true;
        }
    }

    async function boot() {
        const multi = await loadBrands();
        if (multi) {
            // Default to the first brand so the form, theme and cached spec
            // are all coherent before anybody taps anything.
            await useBrand((brands.brands[0] || {}).id);
            if (!config) {
                document.body.innerHTML = '<p style="padding:40px;font-size:20px">Can\'t reach the intake server and no cached form yet — check the wifi and reload.</p>';
                return;
            }
            paintSplash();
            paintSyncPill();
            showSplash();
            startLoops();
            return;
        }
        if (!await loadConfig()) {
            document.body.innerHTML = '<p style="padding:40px;font-size:20px">Can\'t reach the intake server and no cached form yet — check the wifi and reload.</p>';
            return;
        }
        render();
        paintSyncPill();
        showAttract();
        startLoops();
    }

    /** The background work: sync, status, keep-alive. Same for both brands. */
    function startLoops() {
        pollStatus();
        flushQueue();
        setInterval(pollStatus, 60 * 1000);
        setInterval(flushQueue, 15 * 1000);
        window.addEventListener('online', () => { paintSyncPill(); flushQueue(); });
        window.addEventListener('offline', paintSyncPill);
        // Keep-alive: free-tier hosts sleep after ~15 idle minutes, and a
        // cold start is a ~50s stare at a blank iPad for the next visitor.
        // A tiny ping while the kiosk is open keeps the booth warm.
        setInterval(() => fetch('/api/form', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    boot();
})();
