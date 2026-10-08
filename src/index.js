// Cloudflare Worker entry point. Static assets (public/) are served by
// wrangler's [assets] binding; only non-asset requests reach this handler:
//   GET /config   -> instance config (signaling server + buttons)
//   *   /server   -> WebSocket signaling, routed to the PairDrop DO

import { PairDropDO } from './pairdrop-do.js';

export { PairDropDO };

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/config') {
            return Response.json({
                signalingServer: false,
                buttons: {
                    donation_button: { active: false, link: '', title: '' },
                    twitter_button: { active: false, link: '', title: '' },
                    mastodon_button: { active: false, link: '', title: '' },
                    bluesky_button: { active: false, link: '', title: '' },
                    custom_button: { active: false, link: '', title: '' },
                    privacypolicy_button: { active: false, link: '', title: '' },
                },
            });
        }

        if (url.pathname.startsWith('/server')) {
            if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
                return new Response('WebSocket required', {
                    status: 426,
                    headers: { 'Upgrade': 'websocket' },
                });
            }
            // All peers share one DO instance so they can see each other.
            const id = env.PAIRDROP.idFromName('global');
            const stub = env.PAIRDROP.get(id);
            return stub.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    },
};
