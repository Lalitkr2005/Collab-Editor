const WebSocket  = require('ws');
const http       = require('http');
const Y          = require('yjs');
const { executeCode } = require('./executor');

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Collab Editor Server Running');
});

const wss = new WebSocket.Server({ server: httpServer });

// Message types — numbers used in binary protocol
// Wire format matches the client: [1 type byte][raw payload bytes] — no length prefix.
const MESSAGE_SYNC      = 0;   // Yjs document update
const MESSAGE_AWARENESS = 1;   // cursor/presence update, JSON-encoded { clientId, state }
const MESSAGE_RUN       = 2;   // request to run code, JSON-encoded { code, language }
const MESSAGE_OUTPUT    = 3;   // a chunk of run output, JSON-encoded { chunk }

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients:         new Set(),
      ydoc:            new Y.Doc(),
      awarenessStates: new Map(), // clientId -> state
      running:         false,     // true while a run is executing in this room
    });
    console.log(`Room "${roomId}" created`);
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.clients.size === 0) {
    room.ydoc.destroy();
    rooms.delete(roomId);
    console.log(`Room "${roomId}" deleted`);
  }
}

function broadcast(room, message, exceptSocket) {
  room.clients.forEach((client) => {
    if (client !== exceptSocket && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function encodeAwarenessMessage(clientId, state) {
  const stateJson  = JSON.stringify({ clientId, state });
  const stateBytes = new TextEncoder().encode(stateJson);
  const message    = new Uint8Array(1 + stateBytes.byteLength);
  message[0] = MESSAGE_AWARENESS;
  message.set(stateBytes, 1);
  return message;
}

function encodeOutputMessage(chunk) {
  const chunkJson  = JSON.stringify({ chunk });
  const chunkBytes = new TextEncoder().encode(chunkJson);
  const message    = new Uint8Array(1 + chunkBytes.byteLength);
  message[0] = MESSAGE_OUTPUT;
  message.set(chunkBytes, 1);
  return message;
}

wss.on('connection', (socket, request) => {
  const url    = new URL(request.url, 'http://localhost:8080');
  const roomId = url.searchParams.get('room') || 'default';

  const room = getRoom(roomId);
  room.clients.add(socket);
  socket.roomId = roomId;

  console.log(`Client joined "${roomId}". Clients: ${room.clients.size}`);

  // Send new joiner the current document state
  const docUpdate = Y.encodeStateAsUpdate(room.ydoc);
  const docMessage = new Uint8Array(1 + docUpdate.byteLength);
  docMessage[0] = MESSAGE_SYNC;
  docMessage.set(docUpdate, 1);
  socket.send(docMessage);

  // Send new joiner the current awareness state of everyone already in the room
  room.awarenessStates.forEach((state, clientId) => {
    socket.send(encodeAwarenessMessage(clientId, state));
  });

  socket.on('message', (rawMessage) => {
    try {
      const data    = new Uint8Array(rawMessage);
      const msgType = data[0];
      const payload = data.slice(1);

      if (msgType === MESSAGE_SYNC) {
        Y.applyUpdate(room.ydoc, payload);
        broadcast(room, rawMessage, socket);
        console.log(`[${roomId}] Doc update (${payload.byteLength} bytes)`);
      }

      if (msgType === MESSAGE_AWARENESS) {
        const { clientId, state } = JSON.parse(new TextDecoder().decode(payload));
        socket.awarenessClientId = clientId;

        if (state === null) {
          room.awarenessStates.delete(clientId);
        } else {
          room.awarenessStates.set(clientId, state);
        }

        broadcast(room, rawMessage, socket);
        console.log(`[${roomId}] Awareness update`);
      }

      if (msgType === MESSAGE_RUN) {
        if (room.running) {
          socket.send(encodeOutputMessage('[Error] A program is already running in this room — please wait for it to finish.\n'));
          return;
        }

        const { code, language } = JSON.parse(new TextDecoder().decode(payload));
        if (typeof code !== 'string' || typeof language !== 'string') {
          socket.send(encodeOutputMessage('[Error] Invalid run request.\n'));
          return;
        }

        room.running = true;
        console.log(`[${roomId}] Run requested (${language})`);

        executeCode(code, language, (chunk) => {
          broadcast(room, encodeOutputMessage(chunk), null);
        }).finally(() => {
          room.running = false;
        });
      }
    } catch (error) {
      console.error(`[${roomId}] Failed to handle message: ${error.message}`);
    }
  });

  socket.on('close', () => {
    room.clients.delete(socket);

    // Remove this user's cursor from awareness and let others know it's gone
    if (socket.awarenessClientId !== undefined) {
      room.awarenessStates.delete(socket.awarenessClientId);
      broadcast(room, encodeAwarenessMessage(socket.awarenessClientId, null), socket);
    }

    console.log(`Client left "${roomId}". Remaining: ${room.clients.size}`);
    cleanupRoom(socket.roomId);
  });

  socket.on('error', (error) => {
    console.error(`[${socket.roomId}] Error: ${error.message}`);
    const r = rooms.get(socket.roomId);
    if (r) r.clients.delete(socket);
    cleanupRoom(socket.roomId);
  });
});

const PORT = 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
