'use strict';
/**
 * player.js - draws one Cluster Studio design on the instrument cluster ("panel", 1920x720) through cluster-render.
 *
 * What Cluster Studio exported (designs/<id>/design.json) is drawn as:
 *   bg      one image layer: the design's fixed artwork for the drive mode, at reduced size, stretched to the panel
 *   needle  an image layer holding the needle picture, turned about its pivot ("rotate"): no pixels per frame
 *   arc     an effect layer: a dial's value arc, drawn by a shader from two angles
 *   bar     an effect layer: a bar or segmented bar, drawn by a shader from its fill
 *   text    an effect layer: numbers, gear or clock from a glyph atlas (an r8 asset), one uniform per change
 *   lights  an effect layer: shift lights, filled by the count-in shift cue (shift_cue.js) or a plain rpm band
 *   gmeter  an effect layer: the G-meter's dot (its rings are in the background)
 *   turn    an effect layer: the indicator arrows lit (an rgba asset), each side on or off by a uniform, flashing
 * cluster-render takes 8 layers and 16 assets per connection, so the layers are spread over as many connections as
 * they need, stacked by "z" across all of them.
 *
 * The "cluster" setting picks the design; "off" closes every connection, so BMW's own cluster comes back.
 * The drive mode (FES) picks the design's Comfort, Sport or Eco Pro look. While the car switches off no layer is made
 * and those up are dropped (vehicle_state.js, bimmer-lab's port of Redline's guard, MIT), so cluster-render's
 * switch-off guard never counts a strike against it.
 *
 * Node 8 (the head unit's 8.16.2): no optional chaining, no ??. Never throws out of a timer or event: on the car an
 * app that exits twice is uninstalled.
 */
const path = require('path');
const zlib = require('zlib');
const Car = require('./kit/car');
const pack = require('./kit/pack');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');
const tz = require('./tz');
const VehicleState = require('./vehicle_state');
const ShiftCue = require('./shift_cue');

const TARGET = 'panel';
const LAYERS_PER_CONN = 8;
const ASSETS_PER_CONN = 16;
const MODES = ['comfort', 'sport', 'eco'];
const MODE_NAME = { comfort: 'Comfort', sport: 'Sport', eco: 'Eco Pro' };
const D2R = Math.PI / 180;

const PREC = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
`;

/* A bar: solid (u_n < 1.5) or u_n segments, filled to u_frac along x (or up, u_vert), corners rounded by u_r px. */
const BAR_FS = PREC + `
uniform vec2 u_size;
uniform float u_frac;
uniform float u_n;
uniform float u_gap;
uniform float u_r;
uniform float u_vert;
uniform vec4 u_fill;
uniform vec4 u_bg;

float rr(vec2 p, vec2 h, float r) {
    r = min(r, min(h.x, h.y));
    vec2 q = abs(p) - (h - vec2(r));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
void main() {
    vec2 p = v_uv * u_size;
    bool vert = u_vert > 0.5;
    float L = vert ? u_size.y : u_size.x;
    float along = vert ? u_size.y - p.y : p.x;
    vec4 c = vec4(0.0);
    if (u_n < 1.5) {
        float d = rr(p - u_size * 0.5, u_size * 0.5, u_r);
        c = vec4(u_bg.rgb, u_bg.a * clamp(0.5 - d, 0.0, 1.0));
        float fl = L * clamp(u_frac, 0.0, 1.0);
        if (fl > 0.0) {
            vec2 fc = vert ? vec2(u_size.x * 0.5, u_size.y - fl * 0.5) : vec2(fl * 0.5, u_size.y * 0.5);
            vec2 fh = vert ? vec2(u_size.x * 0.5, fl * 0.5) : vec2(fl * 0.5, u_size.y * 0.5);
            float df = rr(p - fc, fh, u_r);
            c = over(vec4(u_fill.rgb, u_fill.a * clamp(0.5 - df, 0.0, 1.0)), c);
        }
    } else {
        float seg = (L - u_gap * (u_n - 1.0)) / u_n;
        float i = floor(along / (seg + u_gap));
        float o = along - i * (seg + u_gap);
        if (i >= 0.0 && i < u_n) {
            float lit = floor(clamp(u_frac, 0.0, 1.0) * u_n + 0.5);
            vec4 col = i < lit ? u_fill : u_bg;
            vec2 q = vert ? vec2(p.x - u_size.x * 0.5, o - seg * 0.5) : vec2(o - seg * 0.5, p.y - u_size.y * 0.5);
            vec2 h = vert ? vec2(u_size.x * 0.5, seg * 0.5) : vec2(seg * 0.5, u_size.y * 0.5);
            float d = rr(q, h, u_r);
            c = vec4(col.rgb, col.a * clamp(0.5 - d, 0.0, 1.0));
        }
    }
    gl_FragColor = c;
}
`;

/* A dial's value arc: radius u_r px, width u_w px, from angle u_a0 to u_a1 (radians, clockwise from 12 o'clock). */
const ARC_FS = PREC + `
uniform vec2 u_size;
uniform float u_r;
uniform float u_w;
uniform float u_a0;
uniform float u_a1;
uniform vec4 u_col;
const float PI = 3.14159265;
void main() {
    vec2 p = (v_uv - 0.5) * u_size;
    float rad = length(p);
    float sweep = abs(u_a1 - u_a0);
    if (sweep < 0.002 || rad < 1.0) { gl_FragColor = vec4(0.0); return; }
    float s = u_a1 >= u_a0 ? 1.0 : -1.0;
    float ang = atan(p.x, -p.y);
    float d = mod(s * (ang - u_a0) + 8.0 * PI, 2.0 * PI);
    if (d > PI + sweep * 0.5) d -= 2.0 * PI;
    float ca = clamp(d * rad + 0.5, 0.0, 1.0) * clamp((sweep - d) * rad + 0.5, 0.0, 1.0);
    float cr = clamp(u_w * 0.5 - abs(rad - u_r) + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(u_col.rgb, u_col.a * ca * cr);
}
`;

/* Text: u_geo.x cells of equal width, the string's glyphs from u_text (8 codes, 4 to a vec4, below 0 = none) placed
 * from cell u_geo.w (a fraction: the alignment). Each glyph is drawn u_geo.z cells wide, centred on its cell, so a
 * wide glyph (M) can reach into its neighbours as it does in Cluster Studio. u_geo.y: the empty cells either side.
 * The atlas (u_font, r8) holds u_grid.x by u_grid.y cells; u_cell = step and glyph size in uv, u_off = the margin. */
const TEXT_FS = PREC + `
uniform sampler2D u_font;
uniform vec4 u_text[2];
uniform vec4 u_geo;
uniform vec2 u_grid;
uniform vec4 u_cell;
uniform vec2 u_off;
uniform vec4 u_color;
float code(float i) {
    if (i < 0.0 || i > 7.5) return -1.0;
    vec4 v = i < 3.5 ? u_text[0] : u_text[1];
    float l = mod(i, 4.0);
    return l < 0.5 ? v.x : l < 1.5 ? v.y : l < 2.5 ? v.z : v.w;
}
float glyph(float c, vec2 q) {
    if (c < 0.0 || q.x < 0.0 || q.x > 1.0) return 0.0;
    float col = mod(c, u_grid.x), row = floor(c / u_grid.x + 0.001);
    vec2 uv = vec2(col * u_cell.x + u_off.x + q.x * u_cell.z, row * u_cell.y + u_off.y + q.y * u_cell.w);
    return texture2D(u_font, uv).r;
}
void main() {
    float total = u_geo.x + 2.0 * u_geo.y;
    float x = v_uv.x * total - u_geo.y - u_geo.w;
    float k = floor(x);
    float a = 0.0;
    for (int d = -1; d <= 1; d++) {
        float i = k + float(d);
        float qx = (x - (i + 0.5)) / u_geo.z + 0.5;
        a = max(a, glyph(code(i), vec2(qx, v_uv.y)));
    }
    gl_FragColor = vec4(u_color.rgb, u_color.a * a);
}
`;

/* Shift lights: u_n lights in a row (round, or bars with u_shape 1), u_lit of them lit (0..1 of the row), coloured by
 * where they sit (up to u_g1 green, up to u_g2 yellow, then red); u_flash 1: all of them in the flash colour. */
const LIGHTS_FS = PREC + `
uniform vec2 u_size;
uniform float u_n;
uniform float u_shape;
uniform float u_lit;
uniform float u_flash;
uniform float u_g1;
uniform float u_g2;
uniform vec4 u_c1;
uniform vec4 u_c2;
uniform vec4 u_c3;
uniform vec4 u_cf;
uniform vec4 u_off;
float rr(vec2 p, vec2 h, float r) {
    r = min(r, min(h.x, h.y));
    vec2 q = abs(p) - (h - vec2(r));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
    vec2 p = v_uv * u_size;
    float gap = min(12.0, u_size.x / u_n * 0.25);
    float cell = (u_size.x - gap * (u_n - 1.0)) / u_n;
    float i = floor(p.x / (cell + gap));
    float o = p.x - i * (cell + gap);
    if (i < 0.0 || i >= u_n || o > cell) { gl_FragColor = vec4(0.0); return; }
    vec2 q = vec2(o - cell * 0.5, p.y - u_size.y * 0.5);
    float d = u_shape > 0.5 ? rr(q, vec2(cell * 0.5, u_size.y * 0.5), min(cell, u_size.y) * 0.2) : length(q) - min(cell, u_size.y) * 0.5;
    float lit = floor(u_lit * u_n + 0.0001);
    float at = (i + 0.5) / u_n;
    vec4 col = u_flash > 0.5 ? u_cf : i >= lit ? u_off : at <= u_g1 ? u_c1 : at <= u_g2 ? u_c2 : u_c3;
    gl_FragColor = vec4(col.rgb, col.a * clamp(0.5 - d, 0.0, 1.0));
}
`;

/* The G-meter's dot: u_g = cornering and braking / accelerating, each -1..1 of the meter's range. */
const GMETER_FS = PREC + `
uniform vec2 u_size;
uniform vec2 u_g;
uniform float u_dr;
uniform vec4 u_dot;
void main() {
    vec2 p = (v_uv - 0.5) * u_size;
    float R = min(u_size.x, u_size.y) * 0.45;
    vec2 g = u_g;
    if (length(g) > 1.0) g = normalize(g);
    float d = length(p - g * R) - u_dr;
    float glow = clamp(1.0 - (d / (u_dr * 1.5)), 0.0, 1.0) * 0.35;
    gl_FragColor = vec4(u_dot.rgb, u_dot.a * max(clamp(0.5 - d, 0.0, 1.0), glow));
}
`;

/* Indicator arrows: the lit arrows' picture (u_img, white), tinted u_col; the left half shows while u_on.x, the right
 * half while u_on.y (a one-sided element gets the same for both). */
const TURN_FS = PREC + `
uniform sampler2D u_img;
uniform vec2 u_on;
uniform vec4 u_col;
void main() {
    vec4 c = texture2D(u_img, v_uv);
    float on = v_uv.x < 0.5 ? u_on.x : u_on.y;
    gl_FragColor = vec4(u_col.rgb, u_col.a * c.a * on);
}
`;

/** The indicators from CDS2 statusIndicate (statusIndicateDirection; its values are not published: names are read
 *  by their German / English words, numbers as 0 off, 1 left, 2 right, 3 both - UNCONFIRMED, every new raw value is
 *  logged once). 'off' | 'left' | 'right' | 'both', or null for a value that says nothing. */
function turnOf(raw) {
    let v = raw;
    if (v && typeof v === 'object') v = v.statusIndicateDirection !== undefined ? v.statusIndicateDirection : v.indicateDirection;
    if (v === undefined || v === null) return null;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
    if (typeof v === 'number') return v === 0 ? 'off' : v === 1 ? 'left' : v === 2 ? 'right' : v === 3 ? 'both' : null;
    const u = String(v).toUpperCase();
    if (/KEIN|NICHT|INAKTIV|INACTIVE|INVALID|UNGUELTIG|SIGNAL|^AUS|_AUS$|^OFF|_OFF$|^NONE/.test(u)) return 'off';
    if (/WARNBLINK|HAZARD|BEIDE|BOTH/.test(u)) return 'both';
    if (/LINKS|LEFT/.test(u)) return 'left';
    if (/RECHTS|RIGHT/.test(u)) return 'right';
    return null;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** The drive mode from FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience (names or wire numbers:
 *  1-3 Sport, 4-6 Comfort, 7-9 Eco Pro, 10 Adaptive), as decoded by f30-cluster (after cauliflowermossgrape, MIT). */
function driveModeOf(raw) {
    let v = raw;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
    if (typeof v === 'number') {
        if (v >= 1 && v <= 3) return 'sport';
        if (v >= 7 && v <= 9) return 'eco';
        if ((v >= 4 && v <= 6) || v === 10) return 'comfort';
        return null;
    }
    if (typeof v !== 'string') return null;
    const u = v.trim().toUpperCase();
    if (u.indexOf('SPORT') === 0) return 'sport';
    if (u.indexOf('ECO') === 0 || u.indexOf('EFFICIEN') === 0) return 'eco';
    if (u.indexOf('COMFORT') === 0 || u.indexOf('ADAPTIVE') === 0) return 'comfort';
    return null;
}

class Player {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.db = pack.open(path.join(__dirname, 'designs'));
        this.index = this.db.json('index.json');
        if (!this.index || !Array.isArray(this.index.designs)) this.index = { designs: [] };
        this.socketPath = process.env.HUD_CLUSTER_SOCKET || (ctx.spec.config && ctx.spec.config.socketPath) || DEFAULT_PATH;
        this.conns = [];
        this.items = [];
        this.design = null;
        this.mode = 'comfort';
        this.fuelL = null; this.rangeKm = null; this.ambient = null; this.boost = null; this.power = null; this.torque = null;
        this.vs = new VehicleState(this.log, () => this._guard('vehicle state', () => this._vehicleChanged()));
        this.cue = new ShiftCue(ctx.dataDir, this.log);
        this.turn = { raw: 'off', side: 'off', lastOn: 0, lastOff: 0, since: 0, pulses: 0, seen: [] };
        this.files = {};
        this.last = Date.now();
        this.statusFns = [];
    }

    start() {
        this.car = new Car(this.ctx, ['rpm', 'speed', 'temps', 'gear', 'accel'], this._extra());
        this.ctx.settings.onChange((key) => this._guard('setting ' + key, () => {
            if (key === 'cluster') this._apply();
            else this._status();
        }));
        this._apply();
        this.timer = setInterval(() => this._guard('tick', () => this._tick()), 33);
        this.statusTimer = setInterval(() => this._guard('status', () => this._status()), 5000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        if (this.statusTimer) clearInterval(this.statusTimer);
        try { this.vs.stop(); } catch (e) { /* stopping */ }
        this._close();
    }

    /** fn() whenever the status line changes (the page redraws). */
    onStatus(fn) { this.statusFns.push(fn); }

    _guard(what, fn) {
        try { return fn(); } catch (e) { this.log.error(what + ': ' + (e && e.stack || e)); return undefined; }
    }

    _setting(key) {
        const s = this.ctx.settings.item(key), v = this.ctx.settings.get(key);
        if (!s) return v;
        if (s.type === 'choice' && !(s.options || []).some((o) => o[0] === v)) return s.default;
        return v;
    }

    /** One statusIndicate value: what is indicating, and whether the car sends the lamp's own on / off (pulsing). */
    _turnFeed(v) {
        const T = this.turn, now = Date.now();
        const key = String(JSON.stringify(v)).slice(0, 80);
        if (T.seen.length < 12 && T.seen.indexOf(key) < 0) { T.seen.push(key); this.log.info('indicators: ' + key + ' -> ' + turnOf(v)); }
        const st = turnOf(v);
        if (st === null) return;
        if (st === 'off') {
            if (T.raw !== 'off' && now - T.lastOn < 900) T.pulses++;      // off again within a blink: the car pulses
            T.lastOff = now;
        } else {
            if (T.raw === 'off' && now - T.lastOn > 900) T.since = now;     // a new indication: flash from now
            T.lastOn = now; T.side = st;
        }
        T.raw = st;
    }

    /** [left, right] lit now: the car's own pulses when it sends them, else our own 1.5 Hz flash while indicating. */
    _turnLit(now) {
        const T = this.turn, pulsing = T.pulses >= 2;
        const active = T.raw !== 'off' || (pulsing && now - T.lastOn < 900);
        if (!active) return [0, 0];
        const on = pulsing ? T.raw !== 'off' : Math.floor((now - (T.since || 0)) / 333) % 2 === 0;
        if (!on) return [0, 0];
        return [T.side === 'left' || T.side === 'both' ? 1 : 0, T.side === 'right' || T.side === 'both' ? 1 : 0];
    }

    _extra() {
        return {
            // the indicators (f30-cluster's feature audit: CDS2 statusIndicate.statusIndicateDirection)
            'de.bmw.infotainment.vehicle.CDS2': {
                statusIndicate: (v) => this._turnFeed(v),
            },
            // fuel (litres, 255 = none) and range (km, 4095 = none), after cauliflowermossgrape's live_data (MIT)
            'de.bmw.infotainment.KombiIF': {
                statusRangeTankStatus: (v) => {
                    const f = v && v.fluidLevelFuelTank, r = v && v.range;
                    this.fuelL = isNum(f) && f >= 0 && f < 255 ? f : null;
                    this.rangeKm = isNum(r) && r >= 0 && r < 4095 ? r : null;
                },
            },
            // outside temperature: raw * 0.5 - 40 deg C, 255 = none (car_vitals, MIT)
            'de.bmw.infrastructure.EnvironmentalInformation': {
                ExteriorTemperature: (v) => {
                    const t = v && v.temperatureExterior;
                    this.ambient = isNum(t) && t !== 255 ? t * 0.5 - 40 : null;
                },
            },
            // the car switching on and off (cluster-render's switch-off guard): vehicle_state.js
            'de.bmw.infrastructure.VehicleCondition': {
                VehicleCondition: (v) => this.vs.feed(v),
            },
            'de.bmw.infotainment.drivingexcitement.FES': {
                // the sport display's power and torque, % of the car's maximum; 255 = none (car_vitals, MIT)
                statusVehicleDynamicEngine: (v) => {
                    const pw = v && v.displaySportEnginePower, tq = v && v.displaySportEngineTorque;
                    this.power = isNum(pw) && pw >= 0 && pw <= 150 ? pw : null;
                    this.torque = isNum(tq) && tq >= 0 && tq <= 150 ? tq : null;
                },
                // boost: displayBoostPressure * 0.01 bar, 255 = none (car_vitals, MIT; not filled on every car)
                statusSwitchDriveDynamicSport2: (v) => {
                    const raw = v && v.displayBoostPressure;
                    this.boost = isNum(raw) && raw !== 255 ? raw * 0.01 : null;
                },
                statusFESVehicleDynamicSwitchHMI: (v) => {
                    const raw = v && v.actualValueModeDrivingExperience, m = driveModeOf(raw);
                    if (!m) { this.log.info('drive mode not recognised: ' + String(JSON.stringify(raw)).slice(0, 60)); return; }
                    if (m === this.mode) return;
                    this.log.info('drive mode ' + MODE_NAME[m] + ' (' + raw + ')');
                    this.mode = m;
                    this._guard('mode', () => this._applyMode());
                },
            },
        };
    }

    /* ---------------- data ---------------- */

    _values() {
        const d = this.car.data();
        const tank = Number(this._setting('tank')) || 60;
        const v = {
            speed: isNum(d.speed) ? d.speed : null,
            rpm: isNum(d.rpm) ? d.rpm : null,
            coolant: isNum(d.coolant) ? d.coolant : null,
            oil: isNum(d.oil) ? d.oil : null,
            fuel: this.fuelL === null ? null : clamp(this.fuelL / tank * 100, 0, 100),
            range: this.rangeKm,
            outside: this.ambient,
            boost: this.boost,
            power: this.power,
            torque: this.torque,
            gLong: isNum(d.gLong) ? d.gLong : null,
            gLat: isNum(d.gLat) ? d.gLat : null,
        };
        if (d.demo) {
            if (v.fuel === null) v.fuel = 68;
            if (v.range === null) v.range = 512;
            if (v.outside === null) v.outside = 14;
            if (v.power === null) v.power = isNum(d.throttle) && isNum(d.rpm) ? clamp(d.throttle * 100 * Math.sin(clamp(d.rpm / 7000, 0, 1) * Math.PI * 0.6), 0, 100) : 0;
            if (v.torque === null) v.torque = isNum(d.torque) ? clamp(d.torque / 5.8, 0, 100) : 0;
            if (v.boost === null) v.boost = isNum(d.throttle) && isNum(d.rpm) ? d.throttle * 1.3 * clamp(d.rpm / 6000, 0, 1) - 0.4 * (1 - d.throttle) : 0;
        }
        if (v.speed !== null && this.design && this.design.speedUnit === 'mph') v.speed *= 0.621371;
        v.gear = this._gear(d);
        v.gearNum = isNum(d.gear) ? d.gear : null;
        v.demo = !!d.demo;
        return v;
    }

    _gear(d) {
        const st = d.stage;
        if (st === 'P' || st === 'R' || st === 'N') return st;
        if (d.gear === -1) return 'R';
        const pre = d.program === 'S' ? 'S' : d.program === 'M' ? 'M' : 'D';
        if (isNum(d.gear) && d.gear > 0) return pre + d.gear;
        if (st === 'D') return pre;
        if (d.demo) return 'D';
        return isNum(d.speed) && d.speed > 2 ? 'D' : 'P';
    }

    _clock(h24) {
        const off = tz.offset(Number(this._setting('tz')));
        const t = new Date(Date.now() + (off || 0) * 60000);
        let h = t.getUTCHours();
        const m = t.getUTCMinutes();
        if (!h24) h = h % 12 || 12;
        return (h24 && h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    /* ---------------- files ---------------- */

    _file(name) {
        const key = this.design.id + '/' + name + '.json';
        if (this.files[key]) return this.files[key];
        const j = this.db.json(key);
        if (!j || !j.d) throw new Error('missing ' + key);
        const out = { w: j.w, h: j.h, px: zlib.inflateSync(Buffer.from(j.d, 'base64')) };
        this.files = {};            // keep one design's worth at most
        this.files[key] = out;
        return out;
    }

    /* ---------------- layers ---------------- */

    _close() {
        this.conns.forEach((c) => { try { c.c.close(); } catch (e) { /* gone */ } });
        this.conns = [];
        this.items = [];
    }

    _conn(nAssets) {
        let c = this.conns[this.conns.length - 1];
        if (!c || c.layers >= LAYERS_PER_CONN || c.assets.size + nAssets > ASSETS_PER_CONN) {
            const n = this.conns.length;
            const name = this.ctx.spec.id + (n ? '_' + (n + 1) : '');
            const cr = new ClusterRender(name, this.socketPath);
            cr.on('layer', (ref, state, reason) => {
                if (state === 'error' || state === 'waiting') this.log.warn('layer ' + name + ':' + ref + ' ' + state + (reason ? ': ' + reason : ''));
            });
            cr.on('error', (e) => this.log.warn('cluster-render ' + name + ': ' + (e && e.message || e)));
            c = { c: cr, layers: 0, assets: new Map() };
            this.conns.push(c);
            cr.connect();
        }
        return c;
    }

    _font(c, key) {
        if (c.assets.has(key)) return c.assets.get(key);
        const f = this.design.fonts[key], img = this._file(f.file);
        const ref = c.c.asset({ target: TARGET, format: 'r8', w: img.w, h: img.h, sampling: 'bilinear' });
        if (!ref) throw new Error('font ' + key + ': asset refused');
        c.c.pixels(ref, null, img.px);
        c.assets.set(key, ref);
        return ref;
    }

    _rgba(c, file) {
        if (c.assets.has(file)) return c.assets.get(file);
        const img = this._file(file);
        const ref = c.c.asset({ target: TARGET, format: 'rgba8', w: img.w, h: img.h, sampling: 'bilinear' });
        if (!ref) throw new Error(file + ': asset refused');
        c.c.pixels(ref, null, img.px);
        c.assets.set(file, ref);
        return ref;
    }

    _apply() {
        this._close();
        const want = this._setting('cluster');
        const meta = this.index.designs.find((x) => x.id === want);
        if (!meta || want === 'off') {
            this.design = null;
            this.log.info(want === 'off' ? 'off: BMW\'s own cluster' : 'no design "' + want + '": BMW\'s own cluster');
            this._status();
            return;
        }
        if (this.vs.hold()) {
            this.design = null;
            this.waiting = true;
            this.log.info('"' + meta.name + '" waits: the car is not on (vehicle state ' + this.vs.text() + ')');
            this._status();
            return;
        }
        this.waiting = false;
        this.design = this.db.json(meta.id + '/design.json');
        this.design.id = meta.id;
        this.log.info('showing "' + meta.name + '" (' + this.design.layers.length + ' moving parts)');
        let z = -900;
        const bg = this.design.bg;
        // the fixed artwork, at its reduced size, stretched over the panel
        {
            const c = this._conn(0), img = this._file(bg.modes[this.mode] || bg.modes.comfort);
            const ref = c.c.image({ target: TARGET, klass: 'content', z: z++, x: 0, y: 0, w: this.design.W, h: this.design.H, iw: img.w, ih: img.h, sampling: 'bilinear' });
            if (!ref) throw new Error('background layer refused');
            c.c.pixels(ref, null, img.px);
            c.layers++;
            this.items.push({ L: { t: 'bg' }, c: c.c, ref, file: bg.modes[this.mode] || bg.modes.comfort });
        }
        this.design.layers.forEach((L, i) => this._guard('layer ' + i + ' (' + L.t + ')', () => {
            const c = this._conn(L.t === 'text' && !this._lastHasFont(L.font) ? 1 : L.t === 'turn' ? 1 : 0);
            const it = { L, c: c.c, ref: 0, cache: {} };
            const base = { target: TARGET, klass: 'content', z: z++, x: L.x, y: L.y, w: L.w, h: L.h };
            if (L.t === 'needle') {
                it.file = L.sprites[this.mode] || L.sprites.comfort;
                const img = this._file(it.file);
                it.ref = c.c.image(Object.assign(base, { iw: img.w, ih: img.h, px: L.px, py: L.py, rotate: L.a0, sampling: 'bilinear' }));
                if (it.ref) c.c.pixels(it.ref, null, img.px);
                it.ang = L.a0;
            } else if (L.t === 'arc') {
                it.ref = c.c.effect(Object.assign(base, { fs: ARC_FS }));
                if (it.ref) {
                    c.c.uniform(it.ref, 'u_size', [L.w, L.h]);
                    c.c.uniform(it.ref, 'u_r', [L.r]);
                    c.c.uniform(it.ref, 'u_w', [L.lw]);
                    c.c.uniform(it.ref, 'u_a0', [L.a0 * D2R]);
                    c.c.uniform(it.ref, 'u_a1', [L.a0 * D2R]);
                }
            } else if (L.t === 'bar') {
                it.ref = c.c.effect(Object.assign(base, { fs: BAR_FS }));
                if (it.ref) {
                    c.c.uniform(it.ref, 'u_size', [L.w, L.h]);
                    c.c.uniform(it.ref, 'u_n', [L.n]);
                    c.c.uniform(it.ref, 'u_gap', [L.gap]);
                    c.c.uniform(it.ref, 'u_r', [L.r]);
                    c.c.uniform(it.ref, 'u_vert', [L.vert ? 1 : 0]);
                    c.c.uniform(it.ref, 'u_frac', [0]);
                }
            } else if (L.t === 'lights') {
                it.ref = c.c.effect(Object.assign(base, { fs: LIGHTS_FS }));
                if (it.ref) {
                    c.c.uniform(it.ref, 'u_size', [L.w, L.h]);
                    c.c.uniform(it.ref, 'u_n', [L.n]);
                    c.c.uniform(it.ref, 'u_shape', [L.shape]);
                    c.c.uniform(it.ref, 'u_g1', [L.g1]);
                    c.c.uniform(it.ref, 'u_g2', [L.g2]);
                    c.c.uniform(it.ref, 'u_lit', [0]);
                    c.c.uniform(it.ref, 'u_flash', [0]);
                }
            } else if (L.t === 'turn') {
                const img = this._rgba(c, L.sprite);
                it.ref = c.c.effect(Object.assign(base, { fs: TURN_FS }));
                if (it.ref) {
                    c.c.bind(it.ref, 'u_img', img);
                    c.c.uniform(it.ref, 'u_on', [0, 0]);
                }
            } else if (L.t === 'gmeter') {
                it.ref = c.c.effect(Object.assign(base, { fs: GMETER_FS }));
                if (it.ref) {
                    c.c.uniform(it.ref, 'u_size', [L.w, L.h]);
                    c.c.uniform(it.ref, 'u_dr', [L.dr]);
                    c.c.uniform(it.ref, 'u_g', [0, 0]);
                }
            } else if (L.t === 'text') {
                const font = this._font(c, L.font), f = this.design.fonts[L.font];
                it.ref = c.c.effect(Object.assign(base, { fs: TEXT_FS }));
                if (it.ref) {
                    c.c.bind(it.ref, 'u_font', font);
                    c.c.uniform(it.ref, 'u_grid', [f.cols, f.rows]);
                    c.c.uniform(it.ref, 'u_cell', f.cell);
                    c.c.uniform(it.ref, 'u_off', f.off);
                    c.c.uniform(it.ref, 'u_geo', [L.cells, L.pad, f.win, 0]);
                    c.c.uniform(it.ref, 'u_text', [-1, -1, -1, -1, -1, -1, -1, -1], { type: 'vec4' });
                }
            }
            if (!it.ref) { this.log.warn('layer ' + i + ' (' + L.t + ') refused'); return; }
            c.layers++;
            this.items.push(it);
        }));
        this._applyMode(true);
        this._status();
    }

    /** The vehicle state changed: drop everything while the car switches off, build again once it is on. */
    _vehicleChanged() {
        if (this.vs.drop() || this.vs.hold()) {
            if (this.design || this.conns.length) { this._close(); this.design = null; this.waiting = true; }
            this._status();
            return;
        }
        if (!this.design) this._apply();
    }

    _lastHasFont(key) {
        const c = this.conns[this.conns.length - 1];
        return !!(c && c.assets.has(key));
    }

    /** The drive mode's look: background, needle pictures, colours, what shows. */
    _applyMode(first) {
        if (!this.design) return;
        const m = this.mode;
        this.items.forEach((it) => this._guard('mode ' + it.L.t, () => {
            const L = it.L;
            if (L.t === 'bg') {
                const f = this.design.bg.modes[m] || this.design.bg.modes.comfort;
                if (f !== it.file) { it.file = f; it.c.pixels(it.ref, null, this._file(f).px); }
                return;
            }
            const show = !L.show || L.show[m] !== false;
            it.c.set(it.ref, { visible: show ? 1 : 0 });
            if (L.t === 'needle') {
                const f = L.sprites[m] || L.sprites.comfort;
                if (f !== it.file) { it.file = f; it.c.pixels(it.ref, null, this._file(f).px); }
            } else if (L.t === 'bar') {
                it.c.uniform(it.ref, 'u_fill', L.fill[m] || L.fill.comfort);
                it.c.uniform(it.ref, 'u_bg', L.bg[m] || L.bg.comfort);
            } else if (L.t === 'text') {
                it.c.uniform(it.ref, 'u_color', L.col[m] || L.col.comfort);
            } else if (L.t === 'lights') {
                ['c1', 'c2', 'c3', 'cf', 'off'].forEach((k) => it.c.uniform(it.ref, 'u_' + k, L[k][m] || L[k].comfort));
            } else if (L.t === 'gmeter') {
                it.c.uniform(it.ref, 'u_dot', L.dot[m] || L.dot.comfort);
            } else if (L.t === 'turn') {
                it.c.uniform(it.ref, 'u_col', L.col[m] || L.col.comfort);
            } else if (L.t === 'arc') {
                it.cache.col = null;        // the colour goes with the next value
            }
        }));
        if (!first) this._status();
    }

    _tick() {
        if (!this.design || !this.items.length) return;
        const now = Date.now(), dt = Math.min(0.2, (now - this.last) / 1000);
        this.last = now;
        const v = this._values(), m = this.mode;
        const k = 1 - Math.exp(-dt * 14);
        // the smoothed rpm the shift lights count by (the needles' own smoothing, for one shared shift cue)
        if (v.rpm !== null) this.rpmShow = this.rpmShow === undefined ? v.rpm : this.rpmShow + (v.rpm - this.rpmShow) * k;
        this.items.forEach((it) => {
            const L = it.L;
            if (L.t === 'bg') return;
            const frac = (src) => {
                const x = v[src];
                return x === null || x === undefined ? 0 : clamp((x - L.min) / ((L.max - L.min) || 1), 0, 1);
            };
            if (L.t === 'needle') {
                const target = L.a0 + frac(L.src) * (L.a1 - L.a0);
                it.ang += (target - it.ang) * k;
                if (Math.abs(it.ang - (it.sent === undefined ? 1e9 : it.sent)) >= 0.05) {
                    it.sent = it.ang;
                    it.c.set(it.ref, { rotate: Math.round(it.ang * 100) / 100 });
                }
            } else if (L.t === 'arc') {
                if (it.ang === undefined) it.ang = L.a0;
                const target = L.a0 + frac(L.src) * (L.a1 - L.a0);
                it.ang += (target - it.ang) * k;
                const red = L.red !== null && L.red !== undefined && v[L.src] !== null && v[L.src] >= L.red;
                const col = red ? L.redCol : (L.col[m] || L.col.comfort);
                if (it.cache.col !== col) { it.cache.col = col; it.c.uniform(it.ref, 'u_col', col); }
                if (Math.abs(it.ang - (it.sent === undefined ? 1e9 : it.sent)) >= 0.05) {
                    it.sent = it.ang;
                    it.c.uniform(it.ref, 'u_a1', [it.ang * D2R]);
                }
            } else if (L.t === 'lights') {
                let lit = 0, flash = false;
                if (v.rpm !== null) {
                    if (L.cue === 'countin') {
                        if (it.cueAt !== now) {
                            this.cue.tick(v.rpm, now, L.shift, L.redline, this.cue.lead(), v.gearNum, this.rpmShow, () => true, v.demo ? null : { mode: null });
                            it.cueAt = now;
                        }
                        lit = this.cue.fraction(this.rpmShow);
                        flash = this.cue.blink(now);
                    } else {
                        lit = clamp((this.rpmShow - L.from) / ((L.shift - L.from) || 1), 0, 1);
                        flash = this.rpmShow >= L.shift && Math.floor(now / 100) % 2 === 0;
                    }
                }
                lit = Math.round(lit * 100) / 100;
                if (lit !== it.cache.lit) { it.cache.lit = lit; it.c.uniform(it.ref, 'u_lit', [lit]); }
                if (flash !== it.cache.flash) { it.cache.flash = flash; it.c.uniform(it.ref, 'u_flash', [flash ? 1 : 0]); }
            } else if (L.t === 'turn') {
                let on = this._turnLit(now);
                if (v.demo && this.turn.seen.length === 0) on = Math.floor(now / 6000) % 3 === 1 && Math.floor(now / 333) % 2 === 0 ? [1, 0] : [0, 0];
                if (L.side === 'left') on = [on[0], on[0]];
                else if (L.side === 'right') on = [on[1], on[1]];
                const k2 = on[0] + ',' + on[1];
                if (k2 !== it.cache.on) { it.cache.on = k2; it.c.uniform(it.ref, 'u_on', on); }
            } else if (L.t === 'gmeter') {
                const gx = (v.gLat === null ? 0 : v.gLat) / L.range * (L.flipX ? -1 : 1);
                const gy = (v.gLong === null ? 0 : v.gLong) / L.range * (L.flipY ? -1 : 1);
                if (it.gx === undefined) { it.gx = gx; it.gy = gy; }
                it.gx += (gx - it.gx) * k; it.gy += (gy - it.gy) * k;
                const g = [Math.round(it.gx * 500) / 500, Math.round(it.gy * 500) / 500];
                if (g[0] !== it.cache.gx || g[1] !== it.cache.gy) { it.cache.gx = g[0]; it.cache.gy = g[1]; it.c.uniform(it.ref, 'u_g', g); }
            } else if (L.t === 'bar') {
                const f = Math.round(frac(L.src) * 1000) / 1000;
                if (f !== it.cache.f) { it.cache.f = f; it.c.uniform(it.ref, 'u_frac', [f]); }
            } else if (L.t === 'text') {
                let s;
                if (L.kind === 'gear') s = v.gear;
                else if (L.kind === 'clock') s = this._clock(!!L.h24);
                else {
                    const x = v[L.src];
                    s = x === null || x === undefined ? '--' : x.toFixed(L.dec || 0);
                    if (s === '-0') s = '0';
                }
                s = String(s);
                if (s.length > L.cells) s = s.slice(s.length - L.cells);
                if (s !== it.cache.s) {
                    it.cache.s = s;
                    const chars = this.design.fonts[L.font].chars, codes = [];
                    for (let i = 0; i < 8; i++) codes.push(i < s.length ? chars.indexOf(s[i]) : -1);
                    it.c.uniform(it.ref, 'u_text', codes, { type: 'vec4' });
                    const shift = (L.cells - s.length) * L.align;
                    it.c.uniform(it.ref, 'u_geo', [L.cells, L.pad, this.design.fonts[L.font].win, shift]);
                }
            }
        });
    }

    _status() {
        let t;
        if (!this.design && this.waiting) t = 'Waiting for the car to be on';
        else if (!this.design) t = 'Off: BMW\'s own cluster is showing';
        else {
            const meta = this.index.designs.find((x) => x.id === this.design.id);
            t = 'Showing ' + (meta ? meta.name : this.design.id) + ' (' + MODE_NAME[this.mode] + ')';
            try { if (this.car && this.car.data().demo) t += ' - demo data, no car signals yet'; } catch (e) { /* no car yet */ }
        }
        if (t === this.lastStatus) return;
        this.lastStatus = t;
        try { if (this.ctx.ui.comp('STATUS')) this.ctx.ui.text('STATUS', t); } catch (e) { /* screen not up yet */ }
        this.statusFns.forEach((fn) => { try { fn(); } catch (e) { /* the page redraws next time */ } });
    }
}

Player.driveModeOf = driveModeOf;
Player.turnOf = turnOf;
module.exports = Player;
