/**
 * SafariMagic Mirror Server
 * Serveur relais WebSocket pour Les French Twins
 *
 * Ce serveur reçoit les recherches depuis l'app SafariMagic
 * et les transmet en temps réel à tous les clients miroir connectés.
 *
 * Usage:
 *   npm install
 *   npm start
 *
 * Le serveur sert aussi la page miroir sur http://localhost:3333
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir la page miroir
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint HTTP pour recevoir les recherches depuis l'app iOS
// (alternative au WebSocket, plus simple depuis iOS)
app.post('/search', (req, res) => {
  const { query, url, type } = req.body;
  console.log(`🔍 Recherche reçue: "${query || url}" (type: ${type || 'search'})`);

  // Broadcaster à tous les clients miroir WebSocket
  const message = JSON.stringify({
    type: type || 'search',
    query: query || '',
    url: url || '',
    timestamp: Date.now()
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });

  res.json({ success: true });
});

// Endpoint pour vérifier que le serveur est en ligne
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', clients: wss.clients.size });
});

// WebSocket connections
wss.on('connection', (ws, req) => {
  console.log(`✅ Client miroir connecté (total: ${wss.clients.size})`);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`🔍 Recherche via WS: "${message.query || message.url}"`);

      // Relayer à tous les AUTRES clients
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            ...message,
            timestamp: Date.now()
          }));
        }
      });
    } catch (e) {
      console.error('Message invalide:', e);
    }
  });

  ws.on('close', () => {
    console.log(`❌ Client déconnecté (restant: ${wss.clients.size})`);
  });
});

// Obtenir l'IP locale pour afficher l'URL d'accès
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('🪄 ═══════════════════════════════════════════');
  console.log('   SafariMagic Mirror - Les French Twins');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log(`📱 Page miroir (même réseau WiFi):`);
  console.log(`   http://${localIP}:${PORT}`);
  console.log('');
  console.log(`💻 Page miroir (cet ordi):`);
  console.log(`   http://localhost:${PORT}`);
  console.log('');
  console.log(`🔗 API endpoint pour l'app iOS:`);
  console.log(`   http://${localIP}:${PORT}/search`);
  console.log('');
  console.log('En attente de recherches...');
  console.log('');
});
