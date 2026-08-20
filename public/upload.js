// ========================================================
// Filename: public/upload.js
// Description: The customer's own phone, sending photographs
// into their enquiry.
//
// Photographs are downscaled in the browser before they are
// sent. A modern phone camera produces 4-12MB per image; at
// that size a handful of photographs would stall on show-floor
// cellular and buy nothing — a 2000px JPEG is already more
// detail than an estimator needs.
// ========================================================
(() => {
    const $ = (s) => document.querySelector(s);
    const token = location.pathname.split('/').filter(Boolean).pop();
    const picked = [];   // { name, dataUrl }

    const MAX_EDGE = 2000;
    const QUALITY = 0.82;
    const MAX_FILES = 12;

    fetch(`/u/${token}/info`)
        .then(r => r.ok ? r.json() : null)
        .then(info => {
            if (info?.firstName) {
                $('#lede').textContent = `${info.firstName}, send us photographs of your project`;
            }
        })
        .catch(() => { /* the page still works without the greeting */ });

    /** Downscale to a sane edge length and re-encode as JPEG. */
    function shrink(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', QUALITY));
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
            img.src = url;
        });
    }

    function paintThumbs() {
        $('#thumbs').innerHTML = picked.map((p, i) =>
            `<div class="thumb"><img src="${p.dataUrl}" alt="">
               <button type="button" class="thumb-x" data-i="${i}" aria-label="Remove photograph">×</button>
             </div>`).join('');
        $('#send').hidden = picked.length === 0;
        $('#send').textContent = picked.length === 1
            ? 'Send photograph' : `Send ${picked.length} photographs`;
    }

    $('#thumbs').addEventListener('click', (e) => {
        const i = e.target?.dataset?.i;
        if (i === undefined) return;
        picked.splice(Number(i), 1);
        paintThumbs();
    });

    $('#picker').addEventListener('change', async (e) => {
        const files = [...e.target.files].filter(f => /^image\//.test(f.type));
        e.target.value = '';
        if (!files.length) return;
        const msg = $('#msg');
        msg.className = 'phone-msg';
        msg.textContent = 'Preparing photographs…';
        for (const file of files) {
            if (picked.length >= MAX_FILES) break;
            try {
                picked.push({ name: file.name || 'photo.jpg', dataUrl: await shrink(file) });
            } catch { /* skip anything the browser cannot decode */ }
        }
        msg.textContent = picked.length >= MAX_FILES
            ? `That is the maximum of ${MAX_FILES} photographs.` : '';
        paintThumbs();
    });

    $('#send').addEventListener('click', async () => {
        const btn = $('#send');
        const msg = $('#msg');
        btn.disabled = true;
        msg.className = 'phone-msg';
        msg.textContent = 'Sending…';
        try {
            const res = await fetch(`/u/${token}/photos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ photos: picked }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Upload failed.');
            picked.length = 0;
            paintThumbs();
            msg.textContent = '';
            $('#done').hidden = false;
            $('#done-sub').textContent = data.saved === 1
                ? 'Your photograph has been added to your enquiry.'
                : `Your ${data.saved} photographs have been added to your enquiry.`;
        } catch (err) {
            msg.className = 'phone-msg bad';
            msg.textContent = `${err.message} Please check your connection and try again.`;
        } finally {
            btn.disabled = false;
        }
    });

    $('#more').addEventListener('click', () => {
        $('#done').hidden = true;
        $('#picker').click();
    });
})();
