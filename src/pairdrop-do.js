// Cloudflare Workers Durable Object that replaces PairDrop's Node.js
// ws-server.js. All peers connect to a single DO instance, which holds the
// room/secret/peer state -- mirroring the original single-process in-memory
// model. Hibernatable WebSockets let the DO sleep while connections are idle.

import { describeUserAgent } from './peer-info.js';
import { getRandomString, randomPairKey, hashCodeSalted } from './helper.js';

const KEEPALIVE_INTERVAL_MS = 30 * 1000; // send a ping this often
const KEEPALIVE_TIMEOUT_MS = 2 * KEEPALIVE_INTERVAL_MS; // drop peers silent for two rounds
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // join-key rate limit window
const RATE_LIMIT_MAX = 10; // max join attempts per window

const UUID_RE = /^([0-9]|[a-f]){8}-(([0-9]|[a-f]){4}-){3}([0-9]|[a-f]){12}$/;

export class PairDropDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // pairKey -> { roomSecret, creatorId }
        // Persisted in DO storage so it survives hibernation eviction.
        this._roomSecrets = null;
        this._hasherPassword = null;
    }

    // ---- lifecycle -------------------------------------------------------

    async fetch(request) {
        if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
            return new Response('WebSocket required', {
                status: 426,
                headers: { 'Upgrade': 'websocket' },
            });
        }

        await this._loadState();

        const url = new URL(request.url);
        const rtcSupported = url.searchParams.get('webrtc_supported') === 'true';
        const peerIdParam = url.searchParams.get('peer_id');
        const peerIdHashParam = url.searchParams.get('peer_id_hash');

        let peerId;
        if (peerIdParam && UUID_RE.test(peerIdParam) &&
            await this._isPeerIdHashValid(peerIdParam, peerIdHashParam)) {
            peerId = peerIdParam;
        } else {
            peerId = crypto.randomUUID();
        }

        const name = describeUserAgent(request.headers.get('User-Agent'), peerId);
        const ip = this._clientIp(request);

        const info = {
            id: peerId,
            name,
            rtcSupported,
            ip,
            roomSecrets: [],
            publicRoomId: null,
            pairKey: null,
            lastBeat: Date.now(),
            requestTimes: [],
        };

        const [client, server] = Object.values(new WebSocketPair());
        this.state.acceptWebSocket(server, [peerId]);
        server.serializeAttachment(info);

        // Send ws-config and display-name immediately.
        this._send(server, {
            type: 'ws-config',
            wsConfig: {
                rtcConfig: {
                    sdpSemantics: 'unified-plan',
                    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                },
                wsFallback: false,
            },
        });

        this._send(server, {
            type: 'display-name',
            displayName: name.displayName,
            deviceName: name.deviceName,
            peerId: peerId,
            peerIdHash: await hashCodeSalted(this._hasherPassword, peerId),
        });

        this.state.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        if (typeof message !== 'string') return;
        let msg;
        try {
            msg = JSON.parse(message);
        } catch {
            return;
        }

        // Restore persisted state after hibernation (constructor is sync).
        await this._loadState();

        const info = ws.deserializeAttachment();
        if (!info) return;
        info.lastBeat = Date.now();
        ws.serializeAttachment(info);

        switch (msg.type) {
            case 'disconnect':
                this._disconnect(ws);
                return;
            case 'pong':
                return;
            case 'join-ip-room':
                this._joinIpRoom(ws, info);
                break;
            case 'room-secrets':
                this._onRoomSecrets(ws, info, msg);
                break;
            case 'room-secrets-deleted':
                this._onRoomSecretsDeleted(ws, info, msg);
                break;
            case 'pair-device-initiate':
                this._onPairDeviceInitiate(ws, info);
                break;
            case 'pair-device-join':
                this._onPairDeviceJoin(ws, info, msg);
                break;
            case 'pair-device-cancel':
                this._onPairDeviceCancel(ws, info);
                break;
            case 'regenerate-room-secret':
                this._onRegenerateRoomSecret(ws, info, msg);
                break;
            case 'create-public-room':
                this._onCreatePublicRoom(ws, info);
                break;
            case 'join-public-room':
                this._onJoinPublicRoom(ws, info, msg);
                break;
            case 'leave-public-room':
                this._onLeavePublicRoom(ws, info);
                break;
            case 'signal':
                this._signalAndRelay(ws, info, msg);
                break;
            default:
                // ws-fallback relay types (request, header, partition, ...)
                if (msg.to) {
                    this._signalAndRelay(ws, info, msg);
                }
        }
    }

    async webSocketClose(ws) {
        await this._loadState();
        this._disconnect(ws);
    }

    async webSocketError(ws) {
        try { ws.close(1011, 'error'); } catch { /* ignore */ }
    }

    async alarm() {
        const now = Date.now();
        let anyActive = false;
        for (const ws of this.state.getWebSockets()) {
            const info = ws.deserializeAttachment();
            if (!info) continue;
            anyActive = true;
            if (now - info.lastBeat > KEEPALIVE_TIMEOUT_MS) {
                ws.close(4001, 'keepalive timeout'); // triggers webSocketClose -> _disconnect
                continue;
            }
            this._send(ws, { type: 'ping' });
        }
        if (anyActive) {
            this.state.storage.setAlarm(now + KEEPALIVE_INTERVAL_MS);
        }
    }

    // ---- room membership -------------------------------------------------

    _joinIpRoom(ws, info) {
        this._joinRoom(ws, info, 'ip', info.ip);
    }

    _joinSecretRoom(ws, info, roomSecret) {
        this._joinRoom(ws, info, 'secret', roomSecret);
        if (!info.roomSecrets.includes(roomSecret)) {
            info.roomSecrets.push(roomSecret);
            ws.serializeAttachment(info);
        }
    }

    _joinPublicRoom(ws, info, publicRoomId) {
        this._leavePublicRoom(ws, info, false);
        this._joinRoom(ws, info, 'public-id', publicRoomId);
        info.publicRoomId = publicRoomId;
        ws.serializeAttachment(info);
    }

    _joinRoom(ws, info, roomType, roomId) {
        // If already in this room, leave first to avoid duplicate
        // peer-joined/peer-left ordering issues on reconnect.
        if (this._isInRoom(info, roomId)) {
            this._leaveRoom(ws, info, roomType, roomId, false);
        }

        // notify existing peers about the newcomer
        const joined = {
            type: 'peer-joined',
            peer: this._peerInfo(info),
            roomType,
            roomId,
        };
        for (const { ws: otherWs, info: otherInfo } of this._peersInRoom(roomId)) {
            if (otherInfo.id === info.id) continue;
            this._send(otherWs, joined);
        }

        // notify newcomer about existing peers
        const others = this._peersInRoom(roomId)
            .filter(({ info: oi }) => oi.id !== info.id)
            .map(({ info: oi }) => this._peerInfo(oi));
        this._send(ws, {
            type: 'peers',
            peers: others,
            roomType,
            roomId,
        });

        // mark membership
        if (roomType === 'ip') info.ip = info.ip; // already set
        // membership for secret/public is recorded on the caller side so the
        // attachment reflects it after this method returns. For 'ip' the
        // membership is implicit (info.ip === roomId).
    }

    _leaveIpRoom(ws, info, disconnect) {
        this._leaveRoom(ws, info, 'ip', info.ip, disconnect);
    }

    _leaveSecretRoom(ws, info, roomSecret, disconnect) {
        this._leaveRoom(ws, info, 'secret', roomSecret, disconnect);
        const idx = info.roomSecrets.indexOf(roomSecret);
        if (idx >= 0) {
            info.roomSecrets.splice(idx, 1);
            ws.serializeAttachment(info);
        }
    }

    _leavePublicRoom(ws, info, disconnect) {
        if (!info.publicRoomId) return;
        const roomId = info.publicRoomId;
        this._leaveRoom(ws, info, 'public-id', roomId, disconnect);
        info.publicRoomId = null;
        ws.serializeAttachment(info);
    }

    _leaveRoom(ws, info, roomType, roomId, disconnect) {
        if (!this._isInRoom(info, roomId)) return;

        // remove membership marker
        if (roomType === 'secret') {
            const idx = info.roomSecrets.indexOf(roomId);
            if (idx >= 0) info.roomSecrets.splice(idx, 1);
        } else if (roomType === 'public-id') {
            info.publicRoomId = null;
        }
        // 'ip' membership is implicit in info.ip, nothing to clear

        const remaining = this._peersInRoom(roomId).filter(({ info: oi }) => oi.id !== info.id);
        if (remaining.length === 0) {
            // room becomes empty
            ws.serializeAttachment(info);
            return;
        }

        const left = {
            type: 'peer-left',
            peerId: info.id,
            roomType,
            roomId,
            disconnect,
        };
        for (const { ws: otherWs } of remaining) {
            this._send(otherWs, left);
        }
        ws.serializeAttachment(info);
    }

    _notifyPeers(ws, info, roomType, roomId) {
        // unused helper kept for API parity; notifications happen inline in _joinRoom
    }

    // ---- message handlers ------------------------------------------------

    _onRoomSecrets(ws, info, msg) {
        if (!Array.isArray(msg.roomSecrets)) return;
        const valid = msg.roomSecrets.filter(s => /^[\x00-\x7F]{64,256}$/.test(s));
        for (const roomSecret of valid) {
            this._joinSecretRoom(ws, info, roomSecret);
        }
    }

    _onRoomSecretsDeleted(ws, info, msg) {
        if (!Array.isArray(msg.roomSecrets)) return;
        for (const roomSecret of msg.roomSecrets) {
            this._deleteSecretRoom(roomSecret);
        }
    }

    _deleteSecretRoom(roomSecret) {
        for (const { ws, info } of this._allPeers()) {
            if (info.roomSecrets.includes(roomSecret)) {
                this._leaveSecretRoom(ws, info, roomSecret, true);
                this._send(ws, {
                    type: 'secret-room-deleted',
                    roomSecret,
                });
            }
        }
    }

    _onPairDeviceInitiate(ws, info) {
        const roomSecret = getRandomString(256);
        const pairKey = this._createPairKey(info.id, roomSecret);

        if (info.pairKey) {
            this._removePairKey(info.pairKey);
        }
        info.pairKey = pairKey;
        ws.serializeAttachment(info);

        this._send(ws, {
            type: 'pair-device-initiated',
            roomSecret,
            pairKey,
        });
        this._joinSecretRoom(ws, info, roomSecret);
    }

    _onPairDeviceJoin(ws, info, msg) {
        if (this._rateLimitReached(ws, info)) {
            this._send(ws, { type: 'join-key-rate-limit' });
            return;
        }

        const entry = this._roomSecrets && this._roomSecrets[msg.pairKey];
        if (!entry || info.id === entry.creatorId) {
            this._send(ws, { type: 'pair-device-join-key-invalid' });
            return;
        }

        const roomSecret = entry.roomSecret;
        const creatorId = entry.creatorId;
        this._removePairKey(msg.pairKey);

        this._send(ws, {
            type: 'pair-device-joined',
            roomSecret,
            peerId: creatorId,
        });
        const creator = this._peerById(creatorId);
        if (creator) {
            this._send(creator.ws, {
                type: 'pair-device-joined',
                roomSecret,
                peerId: info.id,
            });
        }
        this._joinSecretRoom(ws, info, roomSecret);

        if (info.pairKey) this._removePairKey(info.pairKey);
        info.pairKey = null;
        ws.serializeAttachment(info);
    }

    _onPairDeviceCancel(ws, info) {
        const pairKey = info.pairKey;
        if (!pairKey) return;
        this._removePairKey(pairKey);
        info.pairKey = null;
        ws.serializeAttachment(info);
        this._send(ws, {
            type: 'pair-device-canceled',
            pairKey,
        });
    }

    _onCreatePublicRoom(ws, info) {
        const publicRoomId = getRandomString(5, true).toLowerCase();
        this._send(ws, {
            type: 'public-room-created',
            roomId: publicRoomId,
        });
        this._joinPublicRoom(ws, info, publicRoomId);
    }

    _onJoinPublicRoom(ws, info, msg) {
        if (this._rateLimitReached(ws, info)) {
            this._send(ws, { type: 'join-key-rate-limit' });
            return;
        }

        const roomExists = this._peersInRoom(msg.publicRoomId).length > 0;
        if (!roomExists && !msg.createIfInvalid) {
            this._send(ws, { type: 'public-room-id-invalid', publicRoomId: msg.publicRoomId });
            return;
        }

        this._leavePublicRoom(ws, info, false);
        this._joinPublicRoom(ws, info, msg.publicRoomId);
    }

    _onLeavePublicRoom(ws, info) {
        this._leavePublicRoom(ws, info, true);
        this._send(ws, { type: 'public-room-left' });
    }

    _onRegenerateRoomSecret(ws, info, msg) {
        const oldRoomSecret = msg.roomSecret;
        const newRoomSecret = getRandomString(256);

        const peers = this._peersInRoom(oldRoomSecret);
        for (const { ws: peerWs, info: peerInfo } of peers) {
            this._send(peerWs, {
                type: 'room-secret-regenerated',
                oldRoomSecret,
                newRoomSecret,
            });
            const idx = peerInfo.roomSecrets.indexOf(oldRoomSecret);
            if (idx >= 0) {
                peerInfo.roomSecrets.splice(idx, 1);
                peerInfo.roomSecrets.push(newRoomSecret);
                peerWs.serializeAttachment(peerInfo);
            }
        }
    }

    _signalAndRelay(ws, info, msg) {
        if (!msg.to || !UUID_RE.test(msg.to)) return;
        const room = msg.roomType === 'ip' ? info.ip : msg.roomId;
        if (!room) return;

        const recipient = this._peersInRoom(room).find(({ info: oi }) => oi.id === msg.to);
        if (!recipient || recipient.ws === ws) return;

        delete msg.to;
        msg.sender = {
            id: info.id,
            rtcSupported: info.rtcSupported,
        };
        this._send(recipient.ws, msg);
    }

    // ---- pairing / pair keys ---------------------------------------------

    _createPairKey(creatorId, roomSecret) {
        if (!this._roomSecrets) this._roomSecrets = {};
        let pairKey;
        do {
            pairKey = randomPairKey();
        } while (pairKey in this._roomSecrets);
        this._roomSecrets[pairKey] = { roomSecret, creatorId };
        this._persistRoomSecrets();
        return pairKey;
    }

    _removePairKey(pairKey) {
        if (!this._roomSecrets || !(pairKey in this._roomSecrets)) return;
        const creatorId = this._roomSecrets[pairKey].creatorId;
        const creator = this._peerById(creatorId);
        if (creator && creator.info.pairKey === pairKey) {
            creator.info.pairKey = null;
            creator.ws.serializeAttachment(creator.info);
        }
        delete this._roomSecrets[pairKey];
        this._persistRoomSecrets();
    }

    // ---- disconnect ------------------------------------------------------

    _disconnect(ws) {
        const info = ws.deserializeAttachment();
        if (!info) return;

        if (info.pairKey) this._removePairKey(info.pairKey);

        this._leaveIpRoom(ws, info, true);
        for (const roomSecret of [...info.roomSecrets]) {
            this._leaveSecretRoom(ws, info, roomSecret, true);
        }
        this._leavePublicRoom(ws, info, true);

        try { ws.close(1000, 'disconnect'); } catch { /* ignore */ }
    }

    // ---- helpers ---------------------------------------------------------

    _send(ws, message) {
        try {
            ws.send(JSON.stringify(message));
        } catch (e) {
            console.error('send failed:', e);
        }
    }

    _peerInfo(info) {
        return {
            id: info.id,
            name: info.name,
            rtcSupported: info.rtcSupported,
        };
    }

    _allPeers() {
        const out = [];
        for (const ws of this.state.getWebSockets()) {
            const info = ws.deserializeAttachment();
            if (info) out.push({ ws, info });
        }
        return out;
    }

    _peerById(id) {
        for (const ws of this.state.getWebSockets()) {
            const info = ws.deserializeAttachment();
            if (info && info.id === id) return { ws, info };
        }
        return null;
    }

    _isInRoom(info, roomId) {
        if (info.ip === roomId) return true;
        if (info.roomSecrets && info.roomSecrets.includes(roomId)) return true;
        if (info.publicRoomId === roomId) return true;
        return false;
    }

    _peersInRoom(roomId) {
        return this._allPeers().filter(({ info }) => this._isInRoom(info, roomId));
    }

    _clientIp(request) {
        let ip = request.headers.get('CF-Connecting-IP')
            || (request.headers.get('X-Forwarded-For') || '').split(/\s*,\s*/)[0]
            || request.headers.get('cf-connecting-ip')
            || '';
        if (ip.substring(0, 7) === '::ffff:') ip = ip.substring(7);
        // On Cloudflare the visitor IP is always public; private/local
        // normalization from the original server is not needed, but keep
        // localhost mapping for local dev.
        if (ip === '::1' || this._ipIsPrivate(ip)) ip = '127.0.0.1';
        return ip;
    }

    _ipIsPrivate(ip) {
        if (!ip.includes(':')) {
            return /^(10)\.(.*)\.(.*)\.(.*)$/.test(ip)
                || /^(172)\.(1[6-9]|2[0-9]|3[0-1])\.(.*)\.(.*)$/.test(ip)
                || /^(192)\.(168)\.(.*)\.(.*)$/.test(ip);
        }
        const firstWord = ip.split(':').find(el => !!el);
        if (!firstWord) return false;
        return /^fe[c-f][0-f]$/.test(firstWord)
            || /^fc[0-f]{2}$/.test(firstWord)
            || /^fd[0-f]{2}$/.test(firstWord)
            || firstWord === 'fe80'
            || firstWord === '100';
    }

    _rateLimitReached(ws, info) {
        const now = Date.now();
        info.requestTimes = (info.requestTimes || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (info.requestTimes.length >= RATE_LIMIT_MAX) {
            ws.serializeAttachment(info);
            return true;
        }
        info.requestTimes.push(now);
        ws.serializeAttachment(info);
        return false;
    }

    async _isPeerIdHashValid(peerId, peerIdHash) {
        if (!peerIdHash) return false;
        const expected = await hashCodeSalted(this._hasherPassword, peerId);
        return expected === peerIdHash;
    }

    // ---- persistence -----------------------------------------------------

    async _loadState() {
        if (this._roomSecrets === null) {
            this._roomSecrets = (await this.state.storage.get('roomSecrets')) || {};
        }
        if (this._hasherPassword === null) {
            let pw = await this.state.storage.get('hasherPassword');
            if (!pw) {
                pw = getRandomString(128);
                await this.state.storage.put('hasherPassword', pw);
            }
            this._hasherPassword = pw;
        }
    }

    _persistRoomSecrets() {
        this.state.storage.put('roomSecrets', this._roomSecrets || {});
    }
}
