'use strict';
/**
 * page.js - the app's centre-screen page: every cluster as a card with its picture and name, plus BMW's own. A tap
 * shows that cluster on the instrument cluster (the "cluster" setting); "All settings" (the bar) opens the kit's
 * settings sheet for the rest. The pictures are the ones Cluster Studio drew for each design
 * (designs/<id>/pv_big.json and pv_small.json: w, h, d = base64 of the deflated RGBA rows), handed to the kit as
 * pixel images once. A company logo (designs/logo.json, the same format, already at the size it is drawn) shows top
 * right, when the app was built with one.
 *
 * Drawn on the kit's canvas screen (kit/runtime/display.js): with the Store's renderer it fills the screen and taps
 * and the iDrive controller land on the cards (cv.target); without it the same drawing goes to the HMI as a picture.
 * The look follows bimmer-lab's Cluster Themes page (MIT). Plain Node 8 (the car's 8.16.2).
 */
const zlib = require('zlib');
const G = require('./kit/gauges');
const rec = require('./kit/record');

const W = 1600, H = 520;
const A = G.withAlpha;
const C = {
    bg: '#05070a', glow: '#0d1a2e', text: '#eef2f8', dim: '#8a96a8', label: '#6f7b8f', line: '#ffffff12',
    blue: '#2b7fff', blueHi: '#5aa2ff', blueDeep: '#1c69d4', green: '#3ddc84', amber: '#ffb020',
};
const MODE_NAME = { comfort: 'Comfort', sport: 'Sport', eco: 'Eco Pro' };
const BIG = { w: 400, h: 150 }, SMALL = { w: 208, h: 78 };
const COLS = 6, ROWS = 2;
const IMG_BASE = 0x43530000;            // our pixel image ids ('CS' + n), clear of the kit's own

class Page {
    constructor(ctx, player) {
        this.ctx = ctx;
        this.player = player;
        this.pics = Object.create(null);
        this.nextImg = 0;
        this.pageNo = 0;
        this.loop = null;
    }

    start() {
        this.loop = this.ctx.loop('MAIN', 8, () => this.render());
        this.ctx.settings.onChange(() => this.kick());
        if (this.ctx.onLayout) this.ctx.onLayout(() => this.kick());
        this.player.onStatus(() => this.kick());
        this.render();
    }
    kick() { if (this.loop && this.loop.kick) this.loop.kick(); }

    /** A design's picture ('big' or 'small'), or null. */
    pic(id, size) {
        const key = id + ':' + size;
        if (this.pics[key] !== undefined) return this.pics[key];
        let out = null;
        try {
            const j = this.player.db.json(id + '/pv_' + size + '.json');
            if (j && j.d) {
                const px = zlib.inflateSync(Buffer.from(j.d, 'base64'));
                if (px.length === j.w * j.h * 4) {
                    const imgId = IMG_BASE + this.nextImg++;
                    rec.setImage(imgId, j.w, j.h, px);
                    out = { id: imgId, w: j.w, h: j.h };
                }
            }
        } catch (e) { out = null; }
        this.pics[key] = out;
        return out;
    }

    /** The company logo, or null. */
    logo() {
        if (this.logoImg !== undefined) return this.logoImg;
        let out = null;
        try {
            const j = this.player.db.json('logo.json');
            if (j && j.d) {
                const px = zlib.inflateSync(Buffer.from(j.d, 'base64'));
                if (px.length === j.w * j.h * 4) { const id = IMG_BASE + 0xff00; rec.setImage(id, j.w, j.h, px); out = { id, w: j.w, h: j.h }; }
            }
        } catch (e) { out = null; }
        this.logoImg = out;
        return out;
    }

    choose(v) {
        if (this.ctx.settings.get('cluster') !== v) this.ctx.settings.set('cluster', v);
        this.kick();
    }

    render() {
        const cv = this.ctx.canvas(W, H);
        const bottom = G.pageBottom(cv);
        cv.clear(C.bg);
        cv.gradientRect(0, 0, W, bottom + 8, [[0, C.glow], [0.55, '#070a10'], [1, C.bg]]);
        const P = this.player, want = this.ctx.settings.get('cluster');
        const designs = P.index.designs, on = !!P.design;
        let demo = false;
        try { demo = !!(P.car && P.car.data().demo); } catch (e) { demo = false; }
        G.frame(cv, this.ctx.theme ? this.ctx.theme() : null, [], -1, [
            demo ? { text: 'DEMO DATA', color: C.amber } : null,
            { text: on ? 'ON THE CLUSTER' : P.waiting ? 'WAITING FOR THE CAR' : 'CLUSTER OFF', color: on ? C.green : C.dim },
        ]);

        // now showing: the picture, its name, the drive mode and what the app is doing
        const x0 = 24, y0 = 52;
        const meta = designs.find((d) => d.id === want);
        label(cv, x0, y0 + 4, 'Now showing');
        const by = y0 + 14;
        if (meta) this.picture(cv, meta.id, 'big', x0, by, BIG.w, BIG.h);
        else stockPicture(cv, x0, by, BIG.w, BIG.h, 26);
        const rx = x0 + BIG.w + 28;
        cv.text(meta ? meta.name : 'BMW\'s own cluster', rx, by + 40, 34, '#ffffff', { font: 'bold', literal: true });
        cv.text(P.lastStatus || '', rx, by + 72, 18, C.dim, { literal: true });
        if (meta) {
            let cx = rx;
            ['comfort', 'sport', 'eco'].forEach((m) => {
                const now = P.mode === m;
                const w = cv.textWidth(MODE_NAME[m], 15, { font: 'bold', literal: true }) + 26, h = 32;
                cv.roundRect(cx, by + 92, w, h, h / 2, now ? C.blue : '#ffffff10');
                cv.text(MODE_NAME[m], cx + w / 2, by + 113, 15, now ? '#ffffff' : C.dim, { align: 'center', font: 'bold', literal: true });
                cx += w + 8;
            });
            cv.text('The look follows the drive mode', cx + 8, by + 113, 15, C.label, { literal: true });
        }
        const lg = this.logo();
        if (lg) cv.image(lg.id, W - x0 - lg.w, y0 - 4, lg.w, lg.h);
        cv.text('Tap a cluster to show it. All settings: fuel tank, time zone, demo data.', rx, by + BIG.h - 4, 15, C.label, { literal: true });

        // the cards: BMW's own, then every cluster
        const cards = [{ id: 'off', name: 'BMW\'s own', tag: 'stock cluster' }].concat(designs.map((d) => ({ id: d.id, name: d.name, tag: '' })));
        const per = COLS * ROWS, pages = Math.max(1, Math.ceil(cards.length / per));
        if (this.pageNo >= pages) this.pageNo = pages - 1;
        const gap = 12, gy = by + BIG.h + 22, cw = SMALL.w + 16;
        const ch = Math.min(SMALL.h + 44, Math.floor((bottom - gy - gap) / ROWS));
        const gw = COLS * cw + (COLS - 1) * gap;
        const gx = x0;
        cards.slice(this.pageNo * per, this.pageNo * per + per).forEach((c, i) => {
            const x = gx + (i % COLS) * (cw + gap), y = gy + Math.floor(i / COLS) * (ch + gap);
            const sel = (c.id === 'off' && (want === 'off' || !meta)) || c.id === want;
            glass(cv, x, y, cw, ch, sel);
            if (c.id === 'off') stockPicture(cv, x + 8, y + 8, SMALL.w, SMALL.h, 15);
            else this.picture(cv, c.id, 'small', x + 8, y + 8, SMALL.w, SMALL.h);
            cv.text(c.name, x + 12, y + ch - 12, 16, '#ffffff', { font: 'bold', literal: true });
            if (c.tag) cv.text(c.tag, x + cw - 12, y + ch - 12, 12, C.dim, { align: 'right', literal: true });
            if (sel) check(cv, x + cw - 22, y + 22, C.blueHi);
            cv.target(x, y, cw, ch, () => this.choose(c.id), 'card:' + c.id, 16);
        });
        if (pages > 1) {
            const px = gx + gw + 24, pw = 96;
            cv.text((this.pageNo + 1) + ' / ' + pages, px + pw / 2, gy + 20, 15, C.dim, { align: 'center', literal: true });
            arrowBtn(cv, px, gy + 34, pw, 56, 'Next', () => { this.pageNo = (this.pageNo + 1) % pages; this.kick(); }, 'page:next');
            arrowBtn(cv, px, gy + 100, pw, 56, 'Back', () => { this.pageNo = (this.pageNo + pages - 1) % pages; this.kick(); }, 'page:back');
        }
        return this.ctx.ui.image('MAIN_GFX', cv);
    }

    picture(cv, id, size, x, y, w, h) {
        const p = this.pic(id, size);
        cv.roundRect(x - 1, y - 1, w + 2, h + 2, 6, '#000000');
        if (p) cv.image(p.id, x, y, w, h);
        else cv.text('No picture', x + w / 2, y + h / 2 + 6, 15, C.dim, { align: 'center', literal: true });
    }
}

function label(cv, x, y, s) { cv.text(s.toUpperCase(), x, y, 14, C.label, { font: 'bold', spacing: 2.4, literal: true }); }
function glass(cv, x, y, w, h, sel) {
    if (sel) {
        cv.card(x, y, w, h, 16, [[0, A(C.blue, 0.16)], [1, A(C.blueDeep, 0.05)]]);
        cv.strokeRoundRect(x, y, w, h, 16, 2, C.blue);
    } else {
        cv.card(x, y, w, h, 16, [[0, '#ffffff0b'], [1, '#ffffff04']]);
        cv.strokeRoundRect(x, y, w, h, 16, 1, C.line);
    }
}
function stockPicture(cv, x, y, w, h, size) {
    cv.roundRect(x, y, w, h, 6, '#0b0f16');
    cv.strokeRoundRect(x, y, w, h, 6, 1, C.line);
    cv.text('BMW\'s own cluster', x + w / 2, y + h / 2 + size * 0.35, size, C.dim, { align: 'center', literal: true });
}
function check(cv, x, y, c) { cv.line(x - 9, y, x - 3, y + 6, 3, c); cv.line(x - 3, y + 6, x + 9, y - 7, 3, c); }
function arrowBtn(cv, x, y, w, h, text, run, key) {
    cv.card(x, y, w, h, 14, [[0, '#ffffff12'], [1, '#ffffff06']]);
    cv.strokeRoundRect(x, y, w, h, 14, 1, C.line);
    cv.text(text, x + w / 2, y + h / 2 + 6, 17, C.text, { align: 'center', font: 'bold', literal: true });
    cv.target(x, y, w, h, run, key, 14);
}

module.exports = Page;
