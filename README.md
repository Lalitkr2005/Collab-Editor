# Collaborative Code Editor

Real-time collaborative code editor where multiple users edit 
the same file simultaneously — built from scratch to understand
WebSockets, CRDTs, and distributed systems.

## Current Status
- [x] Week 1: WebSocket server with real-time broadcast
- [ ] Week 2: Yjs CRDT for conflict-free sync
- [ ] Week 3: Monaco Editor integration
- [ ] Week 4: Sandboxed Docker code execution
- [ ] Week 5: Redis Pub/Sub + PostgreSQL persistence
- [ ] Week 6: React dashboard + Docker Compose

## Tech Stack
Node.js, Yjs, Monaco Editor, WebSockets, Docker, Redis, PostgreSQL, React

## Run Locally
cd server
npm install
node index.js

Then open client/index.html in two browser tabs.
