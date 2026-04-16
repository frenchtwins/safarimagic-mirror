/**
 * SafariMagic Mirror Server v2.0
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
const wss = new WebSocket.Server({ server, path: '/ws' });

// Also accept WebSocket on root path for backward compat
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

// ===== Apple App Site Association =====
app.get('/.well-known/apple-app-site-association', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(path.join(__dirname, 'public', '.well-known', 'apple-app-site-association'));
});

// Serve static files
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

// App Clip routes
app.get('/clip', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'clip.html'));
});
app.get('/clip/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'clip.html'));
});

// ===== START =====
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🪄 ═══════════════════════════════════════════');
    console.log('   SafariMagic Mirror v2.0 - Les French Twins');
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
