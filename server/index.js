const WebSocket = require('ws');
const http      = require('http');

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Collab Editor Server Running');
});

const wss = new WebSocket.Server({ server: httpServer });

// Before: one Set of clients
// Now: a Map where key = roomId, value = Set of clients in that room
//
// Example after 3 connections:
// rooms = {
//   "abc123": Set { socket1, socket2 },
//   "xyz789": Set { socket3 }
// }
const rooms = new Map();

function getRoomClients(roomId) {
  // If room does not exist yet, create it with an empty Set
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, message, excludeSocket) {
  const clients = getRoomClients(roomId);

  clients.forEach((client) => {
    if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function cleanupRoom(roomId) {
  const clients = getRoomClients(roomId);

  // If room is empty after someone leaves — delete it
  // Prevents memory leak from accumulating empty rooms
  if (clients.size === 0) {
    rooms.delete(roomId);
    console.log(`Room "${roomId}" deleted — no clients remaining`);
  }
}

wss.on('connection', (socket, request) => {
  // Extract roomId from the URL query string
  // ws://localhost:8080?room=abc123  →  roomId = "abc123"
  const url    = new URL(request.url, 'http://localhost:8080');
  const roomId = url.searchParams.get('room') || 'default';

  console.log(`Client joined room "${roomId}"`);

  // Add this socket to the correct room
  const clients = getRoomClients(roomId);
  clients.add(socket);

  // Store roomId on the socket itself so we can access it on disconnect
  socket.roomId = roomId;

  // Tell the new client which room they are in and how many people are here
  socket.send(JSON.stringify({
    type:    'connected',
    roomId:  roomId,
    clients: clients.size
  }));

  // Tell everyone else in the room someone joined
  broadcastToRoom(roomId, {
    type:    'user_joined',
    clients: clients.size
  }, socket);

  socket.on('message', (rawMessage) => {
    const message = JSON.parse(rawMessage.toString());

    // Attach roomId to every message for debugging
    console.log(`[Room: ${roomId}] Received: ${message.type}`);

    // Broadcast only to clients in the SAME room
    broadcastToRoom(roomId, message, socket);
  });

  socket.on('close', () => {
    // Remove from room
    const roomClients = getRoomClients(socket.roomId);
    roomClients.delete(socket);

    console.log(`Client left room "${socket.roomId}". Remaining: ${roomClients.size}`);

    // Tell remaining clients in this room someone left
    broadcastToRoom(socket.roomId, {
      type:    'user_left',
      clients: roomClients.size
    }, null);

    // Clean up empty room
    cleanupRoom(socket.roomId);
  });

  socket.on('error', (error) => {
    console.error(`[Room: ${socket.roomId}] Socket error: ${error.message}`);
    const roomClients = getRoomClients(socket.roomId);
    roomClients.delete(socket);
    cleanupRoom(socket.roomId);
  });
});

const PORT = 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Waiting for connections...');
});