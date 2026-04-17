/**
 * Einstein Mirror Server v2.0
 * Real-time screen mirroring for Les French Twins
 *
 * Features:
 *   - WebSocket hub: phone → server → mirror dashboards
 *   - Real-time keystroke streaming, touch tracking, scroll, link clicks, image taps
 *   - Chronological event timeline with timestamps
 *   - HTTP fallback endpoints
 *   - Apple App Site Association for App Clip
 *   - Auto-ping to keep Render awake
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
// Both use noServer so we handle ALL upgrades manually (avoids conflicts)
const wss = new WebSocket.Server({ noServer: true });
const wssLegacy = new WebSocket.Server({ noServer: true });

app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ===== REMOTE CONFIG (Einstein Web theme switch) =====
// In-memory config, persisted to disk so it survives container restarts.
const fs = require('fs');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '159159';

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        return { theme: 'classic', version: '1.0' };
    }
}
function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {}
}
let remoteConfig = loadConfig();

// Public: app reads this at launch
app.get('/config.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(remoteConfig);
});

// Admin: toggle theme (password in query or body)
app.post('/admin/toggle', (req, res) => {
    const pw = req.query.password || (req.body && req.body.password);
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
    remoteConfig.theme = remoteConfig.theme === 'modern' ? 'classic' : 'modern';
    saveConfig(remoteConfig);
    console.log(`🎭 Theme switched to: ${remoteConfig.theme}`);
    res.json(remoteConfig);
});

// Admin: set theme explicitly
app.post('/admin/set', (req, res) => {
    const pw = req.query.password || (req.body && req.body.password);
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
    const theme = (req.query.theme || (req.body && req.body.theme) || '').toString();
    if (!['classic', 'modern'].includes(theme)) return res.status(400).json({ error: 'invalid theme' });
    remoteConfig.theme = theme;
    saveConfig(remoteConfig);
    console.log(`🎭 Theme set to: ${theme}`);
    res.json(remoteConfig);
});

// Admin page (HTML)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Privacy policy (for Apple App Store listing)
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// ===== SAFARI WEB APP (PWA) =====

// Safari fake app shell
app.get('/safari', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'safari', 'index.html'));
});

// Search proxy — scrapes DuckDuckGo HTML which allows it
app.get('/api/search', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ results: [], total: 0 });
    try {
        const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
        });
        const html = await r.text();
        // Parse results
        const results = [];
        const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = resultRegex.exec(html)) !== null && results.length < 15) {
            let href = m[1];
            // DDG wraps URLs with a redirect — extract the real URL
            try {
                const parsed = new URL(href, 'https://duckduckgo.com');
                const uddg = parsed.searchParams.get('uddg');
                if (uddg) href = decodeURIComponent(uddg);
            } catch(e) {}
            const title = stripHtml(m[2]).trim();
            const snippet = stripHtml(m[3]).trim();
            let host = '';
            try { host = new URL(href).hostname.replace(/^www\./, ''); } catch(e) {}
            if (title && href) results.push({ title, snippet, url: href, host });
        }
        res.json({ results, total: results.length, query: q });
    } catch (e) {
        console.error('[/api/search]', e.message);
        res.json({ results: [], total: 0, error: e.message });
    }
});

// Proxy a remote page through our server to bypass X-Frame-Options / CORS
app.get('/api/proxy', async (req, res) => {
    const target = (req.query.url || '').toString();
    if (!target || !/^https?:\/\//i.test(target)) {
        return res.status(400).send('Invalid URL');
    }
    try {
        const r = await fetch(target, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
        });
        const contentType = r.headers.get('content-type') || 'text/html';
        let body = await r.text();
        // Rewrite links/forms so they also go through the proxy
        if (contentType.includes('text/html')) {
            const baseUrl = new URL(target);
            // Inject a base tag + our tracking script
            body = body.replace(/<head[^>]*>/i, match =>
                match + `<base href="${baseUrl.origin}/">\n<script>
                (function() {
                    var lastScrollSend = 0, lastScrollY = 0;
                    var typingBuffer = new Map();

                    function post(msg) {
                        try { window.parent.postMessage(Object.assign({ __einstein: true }, msg), '*'); } catch(e) {}
                    }

                    // Click tracking (links + images)
                    document.addEventListener('click', function(e) {
                        var a = e.target.closest('a');
                        if (a) {
                            var realHref = a.getAttribute('data-real-href') || a.href || '';
                            var text = (a.innerText || a.textContent || '').trim().slice(0, 200);
                            post({ type:'linkClick', text, href: realHref });
                        }
                        var img = e.target.closest('img');
                        if (img && !a) {
                            post({ type:'imageTap',
                                alt: img.alt || '', src: img.src || '',
                                width: img.naturalWidth || img.width || 0,
                                height: img.naturalHeight || img.height || 0 });
                        }
                    }, true);

                    // Input tracking (search boxes inside the proxied page)
                    document.addEventListener('input', function(e) {
                        var t = e.target;
                        if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
                        if (t.type === 'password' || t.type === 'hidden') return;
                        var val = t.value || '';
                        var prev = typingBuffer.get(t) || '';
                        if (val.length > prev.length) {
                            var added = val.slice(prev.length);
                            for (var i = 0; i < added.length; i++) {
                                post({ type:'keystroke', character: added[i], currentText: val.slice(0, prev.length + i + 1), source:'iframe' });
                            }
                        } else if (val.length < prev.length) {
                            var removed = prev.length - val.length;
                            for (var j = 0; j < removed; j++) {
                                post({ type:'keystroke', character:'⌫', currentText: val, source:'iframe' });
                            }
                        }
                        typingBuffer.set(t, val);
                    }, true);

                    // Form submit = search validated
                    document.addEventListener('submit', function(e) {
                        try {
                            var form = e.target;
                            var q = '';
                            form.querySelectorAll('input').forEach(function(inp) {
                                if ((inp.type==='search' || inp.type==='text' || inp.name==='q') && inp.value) { q = inp.value; }
                            });
                            if (q) post({ type:'search', query: q, source:'iframe' });
                        } catch(e) {}
                    }, true);

                    // Scroll tracking
                    window.addEventListener('scroll', function() {
                        var now = Date.now();
                        if (now - lastScrollSend < 300) return;
                        lastScrollSend = now;
                        var scrollY = window.scrollY || window.pageYOffset || 0;
                        var docHeight = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);
                        var viewHeight = window.innerHeight || 0;
                        var dir = scrollY > lastScrollY ? 'down' : 'up';
                        lastScrollY = scrollY;
                        post({ type:'scroll', offsetY: scrollY, contentHeight: docHeight, viewHeight, direction: dir });
                    }, { passive: true });

                    // Rewrite links to route through proxy
                    function rewrite() {
                        document.querySelectorAll('a[href]').forEach(function(a) {
                            var href = a.href;
                            if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;
                            if (href.indexOf('/api/proxy?url=') !== -1) return;
                            a.setAttribute('data-real-href', href);
                            a.href = '/api/proxy?url=' + encodeURIComponent(href);
                        });
                    }
                    rewrite();
                    try { new MutationObserver(rewrite).observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch(e) {}

                    // Page ready
                    function ready() {
                        post({ type:'navigation', url: ${JSON.stringify(target)}, title: document.title || '' });
                    }
                    if (document.readyState === 'complete' || document.readyState === 'interactive') ready();
                    else document.addEventListener('DOMContentLoaded', ready);
                })();
                </script>`
            );
        }
        // Strip framing headers so we can display in iframe
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.removeHeader('Content-Security-Policy');
        res.send(body);
    } catch (e) {
        console.error('[/api/proxy]', e.message);
        res.status(500).send('Proxy error: ' + e.message);
    }
});

function stripHtml(s) {
    return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Static files (AFTER config routes so /config.json hits the dynamic handler)
app.use(express.static(path.join(__dirname, 'public')));

// ===== STATE =====
const eventLog = [];
const MAX_LOG = 500;
let phoneSocket = null;
const mirrorSockets = new Set();
let lastEvent = null;

// ===== WEBSOCKET HUB =====
function handleWSConnection(ws) {
    console.log('[WS] New connection');

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            if (msg.type === 'identify') {
                if (msg.role === 'phone') {
                    phoneSocket = ws;
                    ws.role = 'phone';
                    console.log('[WS] 📱 Phone connected (session: ' + (msg.sessionId || 'unknown') + ')');
                    broadcast({ type: 'phone_connected', timestamp: new Date().toISOString() });
                } else if (msg.role === 'mirror') {
                    mirrorSockets.add(ws);
                    ws.role = 'mirror';
                    console.log('[WS] 🪞 Mirror connected (' + mirrorSockets.size + ' total)');
                    // Send recent events to new mirror
                    ws.send(JSON.stringify({
                        type: 'event_log',
                        events: eventLog.slice(-100),
                        phoneConnected: phoneSocket !== null && phoneSocket.readyState === WebSocket.OPEN
                    }));
                }
                return;
            }

            if (msg.type === 'ping') return;

            // Screen frames: relay directly, never store (too large)
            if (msg.type === 'screen') {
                if (ws.role === 'phone') {
                    const data = raw.toString ? raw.toString() : JSON.stringify(msg);
                    mirrorSockets.forEach((m) => {
                        if (m.readyState === WebSocket.OPEN) {
                            m.send(data);
                        }
                    });
                }
                return;
            }

            // All other messages from phone → store + relay
            if (ws.role === 'phone') {
                if (!msg.timestamp) msg.timestamp = new Date().toISOString();
                msg.serverTime = new Date().toISOString();
                storeEvent(msg);
                broadcast(msg);

                // Log important events
                if (msg.type === 'search') console.log(`🔍 Search: "${msg.query}"`);
                if (msg.type === 'keystroke') process.stdout.write(msg.character === '⌫' ? '\b' : (msg.character || ''));
                if (msg.type === 'link_click') console.log(`👆 Link: "${msg.linkText}"`);
                if (msg.type === 'image_tap') console.log(`🖼️  Image tap: "${msg.alt || msg.src}"`);
            }

            // Legacy: messages without identify (old app version)
            if (!ws.role) {
                if (!msg.timestamp) msg.timestamp = new Date().toISOString();
                msg.serverTime = new Date().toISOString();
                storeEvent(msg);
                broadcast(msg);
                // Also relay to all other connections (old behavior)
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            }
        } catch (e) {
            console.error('[WS] Parse error:', e.message);
        }
    });

    ws.on('close', () => {
        if (ws.role === 'phone') {
            console.log('[WS] 📱 Phone disconnected');
            phoneSocket = null;
            broadcast({ type: 'phone_disconnected', timestamp: new Date().toISOString() });
        } else if (ws.role === 'mirror') {
            mirrorSockets.delete(ws);
            console.log('[WS] 🪞 Mirror disconnected (' + mirrorSockets.size + ' remaining)');
        }
    });
}

wss.on('connection', handleWSConnection);
wssLegacy.on('connection', handleWSConnection);

// Handle upgrade for both /ws and root path
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        // Legacy: accept WebSocket on any path
        wssLegacy.handleUpgrade(request, socket, head, (ws) => {
            wssLegacy.emit('connection', ws, request);
        });
    }
});

// Heartbeat
const heartbeatInterval = setInterval(() => {
    const checkClients = (wsServer) => {
        wsServer.clients.forEach((ws) => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    };
    checkClients(wss);
    checkClients(wssLegacy);
}, 30000);

function storeEvent(event) {
    eventLog.push(event);
    lastEvent = event;
    if (eventLog.length > MAX_LOG) {
        eventLog.splice(0, eventLog.length - MAX_LOG);
    }
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    mirrorSockets.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });
    // Also send to legacy clients
    wssLegacy.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN && !ws.role) {
            ws.send(data);
        }
    });
}

// ===== HTTP ENDPOINTS =====

app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        version: '2.0',
        phoneConnected: phoneSocket !== null && phoneSocket.readyState === WebSocket.OPEN,
        mirrors: mirrorSockets.size,
        events: eventLog.length
    });
});

// Legacy search endpoint
app.post('/search', (req, res) => {
    const event = {
        ...req.body,
        timestamp: req.body.timestamp || new Date().toISOString(),
        serverTime: new Date().toISOString(),
        source: 'http'
    };
    storeEvent(event);
    broadcast(event);
    console.log(`🔍 [HTTP] Search: "${event.query}"`);
    res.json({ success: true, ok: true });
});

// New event endpoint
app.post('/event', (req, res) => {
    const event = {
        ...req.body,
        serverTime: new Date().toISOString(),
        source: 'http'
    };
    storeEvent(event);
    broadcast(event);
    res.json({ ok: true });
});

// Get event log
app.get('/events', (req, res) => {
    const since = req.query.since ? parseInt(req.query.since) : 0;
    res.json({
        events: eventLog.slice(since),
        total: eventLog.length,
        phoneConnected: phoneSocket !== null && phoneSocket.readyState === WebSocket.OPEN
    });
});

// Last event
app.get('/last', (req, res) => {
    res.json({ event: lastEvent });
});

// Clear log
app.post('/clear', (req, res) => {
    eventLog.length = 0;
    lastEvent = null;
    broadcast({ type: 'clear', timestamp: new Date().toISOString() });
    res.json({ ok: true });
});

// Mirror dashboard
app.get('/mirror', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mirror.html'));
});


// ===== START =====
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🪄 ═══════════════════════════════════════════');
    console.log('   Einstein Mirror v2.0 - Les French Twins');
    console.log('═══════════════════════════════════════════════');
    console.log('');
    console.log(`   HTTP:      http://localhost:${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`   Dashboard: http://localhost:${PORT}/mirror`);
    console.log(`   Ping:      http://localhost:${PORT}/ping`);
    console.log('');

    // Auto-ping to keep Render awake
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
        setInterval(() => {
            const https = require('https');
            https.get(`${RENDER_URL}/ping`, (res) => {
                console.log(`♻️  Auto-ping OK (${new Date().toLocaleTimeString()})`);
            }).on('error', (e) => {
                console.log(`♻️  Auto-ping erreur: ${e.message}`);
            });
        }, 10 * 60 * 1000);
        console.log('♻️  Auto-ping activé (Render stay-alive)');
        console.log('');
    }
});
