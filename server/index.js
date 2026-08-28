const WebSocket  = require('ws');
const http       = require('http');
const Y          = require('yjs');
const { executeCode } = require('./executor');
const db         = require('./db');

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

async function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const room = {
      clients:         new Set(),
      ydoc:            new Y.Doc(),
      awarenessStates: new Map(), // clientId -> state
      running:         false,     // true while a run is executing in this room
    };
    rooms.set(roomId, room);

    // Try to restore a previously persisted snapshot from MySQL. If the DB is
    // unavailable, fall through and keep the freshly created empty room.
    try {
      const saved = await db.loadSnapshot(roomId);
      if (saved && saved.snapshot) {
        Y.applyUpdate(room.ydoc, new Uint8Array(saved.snapshot));
        console.log(`Room "${roomId}" restored from MySQL`);
      } else {
        console.log(`Room "${roomId}" created fresh`);
      }
    } catch (error) {
      console.error(`[${roomId}] Snapshot load failed, continuing with empty room: ${error.message}`);
    }
  }
  return rooms.get(roomId);
}

// Read the collaborative language setting from the shared Y.Doc, defaulting to
// 'javascript' when it has not been set yet.
function getRoomLanguage(room) {
  try {
    return room.ydoc.getMap('meta').get('language') || 'javascript';
  } catch (error) {
    return 'javascript';
  }
}

async function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.clients.size === 0) {
    // Persist a final snapshot before the room leaves memory.
    try {
      const snapshot = Y.encodeStateAsUpdate(room.ydoc);
      await db.saveSnapshot(roomId, Buffer.from(snapshot), getRoomLanguage(room));
      console.log(`Room "${roomId}" saved before cleanup`);
    } catch (error) {
      console.error(`[${roomId}] Final snapshot save failed: ${error.message}`);
    }

    room.ydoc.destroy();
    rooms.delete(roomId);
    console.log(`Room "${roomId}" deleted`);
  }
}

// Periodically persist every live room to MySQL so a server restart does not
// lose in-progress work.
const SNAPSHOT_INTERVAL_MS = 30 * 1000;
setInterval(async () => {
  if (rooms.size === 0) return;

  console.log(`Saving ${rooms.size} rooms to MySQL`);
  for (const [roomId, room] of rooms) {
    try {
      const snapshot = Y.encodeStateAsUpdate(room.ydoc);
      await db.saveSnapshot(roomId, Buffer.from(snapshot), getRoomLanguage(room));
      console.log(`  Room "${roomId}" saved`);
    } catch (error) {
      console.error(`  Room "${roomId}" save failed: ${error.message}`);
    }
  }
}, SNAPSHOT_INTERVAL_MS);

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

wss.on('connection', async (socket, request) => {
  const url    = new URL(request.url, 'http://localhost:8080');
  const roomId = url.searchParams.get('room') || 'default';

  const room = await getRoom(roomId);
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

        const { code, language, username } = JSON.parse(new TextDecoder().decode(payload));
        if (typeof code !== 'string' || typeof language !== 'string') {
          socket.send(encodeOutputMessage('[Error] Invalid run request.\n'));
          return;
        }

        room.running = true;
        console.log(`[${roomId}] Run requested (${language})`);

        broadcast(room, encodeOutputMessage(`[${username} ran ${language} code]\n`), null);

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

  socket.on('close', async () => {
    room.clients.delete(socket);

    // Remove this user's cursor from awareness and let others know it's gone
    if (socket.awarenessClientId !== undefined) {
      room.awarenessStates.delete(socket.awarenessClientId);
      broadcast(room, encodeAwarenessMessage(socket.awarenessClientId, null), socket);
    }

    console.log(`Client left "${roomId}". Remaining: ${room.clients.size}`);
    await cleanupRoom(socket.roomId);
  });

  socket.on('error', (error) => {
    console.error(`[${socket.roomId}] Error: ${error.message}`);
    const r = rooms.get(socket.roomId);
    if (r) r.clients.delete(socket);
    cleanupRoom(socket.roomId);
  });
});

const PORT = 8080;
db.testConnection();
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
