#!/usr/bin/env node
// ========================================================
// Filename: scripts/fetch-gallery.js
// Description: Build the inspiration gallery from
// ironwoodstairs.com/gallery.
//
// Run occasionally, never at request time:
//     npm run gallery
//
// The website tags every photograph (data-tag) and describes
// it (data-alt), so the booth gets the same filters visitors
// would see online rather than a guess at categories.
//
// WordPress publishes a 300px thumbnail beside every upload,
// so the kiosk ships small cached copies (~14KB each) and
// stays fast and offline-capable. The FULL image stays on the
// website and is fetched only when one is attached to a CRM
// lead — rare, and server-side.
// ========================================================
const fs = require('fs');
const path = require('path');

const GALLERY_URL = 'https://ironwoodstairs.com/gallery/';
const OUT_DIR = path.join(__dirname, '..', 'public', 'gallery');
const MANIFEST = path.join(__dirname, '..', 'config', 'gallery.json');
const PER_FILTER = Number(process.env.GALLERY_PER_FILTER) || 18;

/**
 * The booth's filter chips, in the order they appear.
 *
 * A subset of the website's tags: a visitor with a minute to spare wants
 * "glass railings" or "curved stairs", not the full stringer taxonomy.
 * `match` is the website tag this chip selects on.
 */
const FILTERS = [
    { label: 'Glass railings', match: 'Interior Glass' },
    { label: 'Metal railings', match: 'Custom Metal Railing' },
    { label: 'Wood & spindles', match: 'Wood with Metal Spindles' },
    { label: 'All wood', match: 'All Wood' },
    { label: 'Curved stairs', match: 'Curved Stairs' },
    { label: 'Open rise', match: 'Open Rise' },
    { label: 'Floating stairs', match: 'Mono Stringer' },
    { label: 'Cable railing', match: 'Cable Railing' },
    { label: 'Horizontal', match: 'Horizontal' },
    { label: 'Stair lighting', match: 'Stair Lighting' },
    { label: 'Exterior', match: 'Exterior' },
    { label: 'Showers & mirrors', match: 'Bathroom Glass' },
];

const ITEM = /<div class="iw-item"[^>]*?data-id="(\d+)"[^>]*?data-tag="([^"]*)"[^>]*?data-alt="([^"]*)"[^>]*?>\s*<img[^>]*?data-src="([^"]+)"/gi;

const decode = (s) => s
    .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

/**
 * Shrink whatever we downloaded to a real thumbnail.
 *
 * Not every upload has a WordPress crop, so the fallback grabs the full
 * image — which turned 153 photographs into 48MB. A booth kiosk cannot
 * ship that. Node has no image resizing built in, and this runs at build
 * time on a workstation, so Pillow is the pragmatic tool; if it is
 * missing the gallery still works, just heavier.
 */
function shrinkThumbnails() {
    const { spawnSync } = require('child_process');
    const py = `
import sys, os
from PIL import Image
folder = sys.argv[1]
saved = 0
for name in os.listdir(folder):
    p = os.path.join(folder, name)
    before = os.path.getsize(p)
    if before < 60_000:
        continue
    im = Image.open(p).convert('RGB')
    im.thumbnail((520, 520), Image.LANCZOS)
    im.save(p, 'JPEG', quality=78, optimize=True)
    saved += before - os.path.getsize(p)
print(saved)
`;
    const r = spawnSync('python3', ['-c', py, OUT_DIR], { encoding: 'utf8' });
    if (r.status !== 0) {
        console.warn('  (could not shrink thumbnails — Pillow unavailable; gallery will be heavy)');
        return;
    }
    console.log(`  shrank thumbnails, saved ${Math.round(Number(r.stdout) / 1024 / 1024)}MB`);
}

async function main() {
    process.stdout.write('Reading the gallery page… ');
    const html = await (await fetch(GALLERY_URL)).text();
    console.log(`${Math.round(html.length / 1024)}KB`);

    const all = [];
    for (const m of html.matchAll(ITEM)) {
        all.push({
            id: m[1],
            tags: decode(m[2]).split(',').map(t => t.trim()).filter(Boolean),
            alt: decode(m[3]),
            full: m[4],
        });
    }
    console.log(`${all.length} photographs found.`);

    // Pick per filter rather than "newest N", so every chip has something
    // behind it — a filter that lands on an empty grid looks broken.
    const chosen = new Map();
    for (const f of FILTERS) {
        const matches = all.filter(p => p.tags.includes(f.match));
        for (const p of matches.slice(0, PER_FILTER)) chosen.set(p.id, p);
        console.log(`  ${String(matches.length).padStart(4)} tagged "${f.match}" → taking ${Math.min(matches.length, PER_FILTER)}`);
    }
    const picked = [...chosen.values()];
    console.log(`\n${picked.length} unique photographs selected. Downloading thumbnails…`);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const manifest = [];
    let done = 0;
    for (const p of picked) {
        const file = `${p.id}.jpg`;
        const thumbUrl = p.full.replace(/\.(jpe?g)$/i, '-300x200.$1');
        try {
            let res = await fetch(thumbUrl);
            if (!res.ok) res = await fetch(p.full); // not every upload has that crop
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(await res.arrayBuffer()));
            manifest.push({ id: p.id, thumb: `gallery/${file}`, full: p.full, tags: p.tags, alt: p.alt });
            process.stdout.write(`\r  ${++done}/${picked.length}`);
        } catch (err) {
            console.warn(`\n  skipped ${p.id}: ${err.message}`);
        }
    }

    shrinkThumbnails();

    fs.writeFileSync(MANIFEST, JSON.stringify({
        source: GALLERY_URL,
        fetchedCount: manifest.length,
        filters: FILTERS,
        photos: manifest,
    }, null, 2));

    const kb = manifest.reduce((n, p) => n + fs.statSync(path.join(OUT_DIR, path.basename(p.thumb))).size, 0) / 1024;
    console.log(`\nWrote ${manifest.length} photographs (${Math.round(kb)}KB of thumbnails) to config/gallery.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
