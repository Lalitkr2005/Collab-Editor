const WebSocket = require('ws');
const http      = require('http');
const Y         = require('yjs');

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Collab Editor Server Running');
});

const wss = new WebSocket.Server({ server: httpServer });

// Each room now stores TWO things:
// 1. clients  — Set of connected WebSockets
// 2. ydoc     — the Yjs document (the source of truth for this room)
//
// The ydoc lives on the server so new joiners can get the current state
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      ydoc:    new Y.Doc()        // one Yjs document per room
    });
    console.log(`Room "${roomId}" created`);
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.clients.size === 0) {
    room.ydoc.destroy();          // free Yjs memory
    rooms.delete(roomId);
    console.log(`Room "${roomId}" deleted`);
  }
}

wss.on('connection', (socket, request) => {
  const url    = new URL(request.url, 'http://localhost:8080');
  const roomId = url.searchParams.get('room') || 'default';

  const room = getRoom(roomId);
  room.clients.add(socket);
  socket.roomId = roomId;

  console.log(`Client joined "${roomId}". Clients: ${room.clients.size}`);

  // Send the new joiner the CURRENT document state
  // This is how late joiners see existing content
  // Y.encodeStateAsUpdate encodes the entire ydoc as a binary snapshot
  const currentState = Y.encodeStateAsUpdate(room.ydoc);
  socket.send(JSON.stringify({
    type:   'init',
    update: Array.from(currentState)   // convert Uint8Array to regular array for JSON
  }));

  socket.on('message', (rawMessage) => {
    const message = JSON.parse(rawMessage.toString());

    if (message.type === 'sync') {
      // Client sent a Yjs update (a delta of what changed)
      // Step 1: Convert the array back to Uint8Array
      const update = new Uint8Array(message.update);

      // Step 2: Apply the update to the SERVER's ydoc
      // This keeps the server's document in sync
      Y.applyUpdate(room.ydoc, update);

      // Step 3: Broadcast the SAME update to all other clients in the room
      // We broadcast the original update — not a re-encoding
      // This is efficient — the server is just a relay
      room.clients.forEach((client) => {
        if (client !== socket && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type:   'sync',
            update: message.update    // same array, no transformation needed
          }));
        }
      });

      console.log(`[${roomId}] Synced update (${update.byteLength} bytes)`);
    }
  });

  socket.on('close', () => {
    room.clients.delete(socket);
    console.log(`Client left "${roomId}". Remaining: ${room.clients.size}`);
    cleanupRoom(socket.roomId);
  });

  socket.on('error', (error) => {
    console.error(`[${socket.roomId}] Error: ${error.message}`);
    const room = rooms.get(socket.roomId);
    if (room) room.clients.delete(socket);
    cleanupRoom(socket.roomId);
  });
});

const PORT = 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});