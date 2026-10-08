// Dependency-free replacements for ua-parser-js and unique-names-generator.
// Only the fields the PairDrop client actually renders are extracted: os,
// browser, device model, type, deviceName and the "Colorful Animal" display
// name seeded from the peer id via cyrb53 (same hash the original server
// used to seed unique-names-generator).

import { cyrb53 } from './helper.js';

const COLORS = [
    'red', 'orange', 'yellow', 'olive', 'green', 'teal', 'cyan', 'azure',
    'blue', 'violet', 'purple', 'pink', 'brown', 'white', 'black', 'gray',
    'silver', 'maroon', 'navy', 'beige', 'ivory', 'crimson', 'emerald',
    'indigo', 'turquoise', 'amber', 'coral', 'lavender',
];

const ANIMALS = [
    'ant', 'bear', 'bee', 'bird', 'bison', 'buffalo', 'cat', 'chicken',
    'cow', 'crab', 'crocodile', 'deer', 'dog', 'dolphin', 'duck', 'eagle',
    'elephant', 'fish', 'fox', 'frog', 'giraffe', 'goat', 'hamster', 'hawk',
    'hippo', 'horse', 'kangaroo', 'lion', 'lobster', 'monkey', 'mouse',
    'owl', 'panda', 'parrot', 'penguin', 'pig', 'rabbit', 'rhino', 'seal',
    'shark', 'sheep', 'shrimp', 'snake', 'spider', 'squirrel', 'tiger',
    'turtle', 'wolf', 'zebra',
];

export function describeUserAgent(userAgent, peerId) {
    const ua = parseUserAgent(userAgent || '');

    let deviceName = '';
    if (ua.os) {
        deviceName = ua.os.replace('Mac OS', 'Mac') + ' ';
    }
    deviceName += ua.model || ua.browser || 'Unknown Device';

    return {
        model: ua.model,
        os: ua.os,
        browser: ua.browser,
        type: ua.type,
        deviceName,
        displayName: seededDisplayName(peerId),
    };
}

function parseUserAgent(s) {
    let os = '';
    if (/Windows NT|Windows Phone/.test(s)) os = 'Windows';
    else if (/Android/.test(s)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
    else if (/Mac OS X|Macintosh/.test(s)) os = 'Mac OS';
    else if (/CrOS/.test(s)) os = 'Chrome OS';
    else if (/Linux|X11/.test(s)) os = 'Linux';

    let browser = '';
    if (/Edg\//.test(s)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
    else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
    else if (/FxiOS|Firefox\//.test(s)) browser = 'Firefox';
    else if (/CriOS|Chrome\//.test(s)) browser = 'Chrome';
    else if (/Safari\//.test(s)) browser = 'Safari';

    let model = '';
    let type;
    if (/iPad/.test(s)) {
        model = 'iPad';
        type = 'tablet';
    } else if (/iPhone/.test(s)) {
        model = 'iPhone';
        type = 'mobile';
    } else {
        const m = s.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/);
        if (m && !/^[a-z]{2}(-[a-z]{2})?$/i.test(m[1])) model = m[1].trim();
        if (/Mobile|Mobi/.test(s)) type = 'mobile';
    }

    return { os, browser, model, type };
}

// deterministic per peer id, mimicking unique-names-generator's "capital"
// style: e.g. "Emerald Falcon". Seeded with cyrb53(peerId) so the same
// peer id always maps to the same name across reloads.
function seededDisplayName(peerId) {
    const h = Math.abs(cyrb53(String(peerId)));
    const color = COLORS[h % COLORS.length];
    const animal = ANIMALS[Math.floor(h / COLORS.length) % ANIMALS.length];
    return capitalize(color) + ' ' + capitalize(animal);
}

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
