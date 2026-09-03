// Draws the Marketplace/Extensions-view icon: three columns, the middle one
// narrow, on the dark ground the extension is built for.
//
// Written by hand rather than pulled from a library because the extension has
// no runtime or build dependencies and one 256x256 PNG does not justify the
// first one. Run with: node scripts/make-icon.js

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 256;
const BACKGROUND = [31, 36, 48];
const COLUMN = [222, 226, 235];
const ACCENT = [214, 122, 63];

/** Columns as [x, width, colour], laid out to read as a narrow middle pane. */
const COLUMNS = [
    [40, 52, COLUMN],
    [104, 24, ACCENT],
    [140, 76, COLUMN]
];

const TOP = 56;
const BOTTOM = 200;
const RADIUS = 8;

function inRoundedRect(x, y, left, width) {
    const right = left + width;
    if (x < left || x >= right || y < TOP || y >= BOTTOM) {
        return false;
    }
    // Only the corners need testing; everything else is inside the box.
    const cx = x < left + RADIUS ? left + RADIUS : x >= right - RADIUS ? right - 1 - RADIUS : x;
    const cy = y < TOP + RADIUS ? TOP + RADIUS : y >= BOTTOM - RADIUS ? BOTTOM - 1 - RADIUS : y;
    if (cx === x && cy === y) {
        return true;
    }
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
}

function pixels() {
    // One filter byte per scanline, then RGB triples.
    const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
    let at = 0;
    for (let y = 0; y < SIZE; y++) {
        raw[at++] = 0; // filter: none
        for (let x = 0; x < SIZE; x++) {
            let colour = BACKGROUND;
            for (const [left, width, fill] of COLUMNS) {
                if (inRoundedRect(x, y, left, width)) {
                    colour = fill;
                    break;
                }
            }
            raw[at++] = colour[0];
            raw[at++] = colour[1];
            raw[at++] = colour[2];
        }
    }
    return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour
// bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(pixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'resources', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
