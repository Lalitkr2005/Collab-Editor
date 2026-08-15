const WebSocket = require('ws');
const http      = require('http');

// Create a basic HTTP server first
// WebSocket runs on top of HTTP
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Collab Editor WebSocket Server Running');
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server: httpServer });

// Track all connected clients
// We use a Set so adding/removing is O(1)
const clients = new Set();

console.log('Setting up WebSocket server...');

wss.on('connection', (socket) => {
  // A new browser tab connected
  console.log(`Client connected. Total clients: ${clients.size + 1}`);
  
  // Add to our set of active connections
  clients.add(socket);

  // Tell this new client how many people are connected
  socket.send(JSON.stringify({
    type:    'connected',
    clients: clients.size
  }));

  // When this client sends a message
  socket.on('message', (rawMessage) => {
    const message = JSON.parse(rawMessage.toString());
    console.log(`Received: ${JSON.stringify(message)}`);

    // Broadcast to every OTHER connected client
    // This is the core of real-time collaboration
    clients.forEach((client) => {
      if (client !== socket && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  });

  // When this client disconnects
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`Client disconnected. Total clients: ${clients.size}`);

    // Tell remaining clients someone left
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type:    'user_left',
          clients: clients.size
        }));
      }
    });
  });

  // Handle errors without crashing the server
  socket.on('error', (error) => {
    console.error(`Socket error: ${error.message}`);
    clients.delete(socket);
  });
});

// Start listening on port 8080
const PORT = 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Waiting for browser connections...');
});