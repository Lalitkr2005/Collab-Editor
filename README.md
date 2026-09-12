# CodeSync — Real-Time Collaborative Code Editor

A production-grade collaborative code editor where multiple users edit the same file simultaneously in real time — built from scratch to understand WebSockets, CRDTs, distributed systems, and sandboxed code execution.

![CodeSync Demo]()

---

## What It Does

- **Multiple users edit the same file simultaneously** — no conflicts, no overwrites, no data loss
- **Live colored cursor presence** — see exactly where every collaborator is in real time
- **Run code together** — one user clicks Run, everyone in the room sees the output stream live
- **Sandboxed execution** — code runs in an isolated Docker container with no network access, memory limits, and a 10-second timeout
- **Persistent documents** — rooms survive server restarts via MySQL snapshots
- **Shareable rooms** — copy a URL and anyone can join your session instantly

---

## Architecture

```
Browser (Monaco Editor + Yjs)
        │
        │  WebSocket (binary protocol)
        │  msg type 0 = CRDT sync
        │  msg type 1 = cursor awareness
        │  msg type 2 = run request
        │  msg type 3 = execution output
        ▼
Node.js WebSocket Server
        │
        ├── Yjs Y.Doc per room (in-memory CRDT state)
        │
        ├── Awareness protocol (ephemeral cursor state)
        │
        ├── Docker executor (sandboxed code execution)
        │       └── python:3.12-slim
        │       └── node:20-slim
        │       └── gcc:13
        │
        └── MySQL (Y.Doc binary snapshots every 30s)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Editor | Monaco Editor (VS Code engine) |
| Real-time sync | Yjs CRDTs (Y.Text, Y.Map, Awareness) |
| Transport | WebSockets (binary framing, typed protocol) |
| Server | Node.js |
| Code execution | Docker (python:3.12-slim, node:20-slim, gcc:13) |
| Persistence | MySQL — binary Y.Doc snapshots |
| Deployment | Docker Compose |

---

## The Hard Parts

### Conflict-Free Editing (CRDTs)
Every character has a permanent unique ID — `[clientId:sequenceNumber]`. When two users insert at the same position simultaneously, Yjs uses a deterministic tiebreaker so both insertions are preserved and every client converges to the same state without a central coordinator.

### Sandboxed Code Execution
User code runs in a Docker container with:
- `--network none` — no internet access (verified by attempting urllib.request — DNS fails)
- `--memory 128m` — hard RAM limit enforced by the OS kernel
- `--cpus 0.5` — half a CPU core maximum
- `--read-only` — container filesystem is read-only
- `--tmpfs /sandbox:size=10m,exec` — small writable scratch space
- `--user 1000:1000` — non-root user inside container
- 10 second timeout — kills infinite loops

### C++ Compilation Pipeline
C++ requires compile then execute. The compiler writes temporary files so `cd /sandbox` redirects them to the writable tmpfs. The compiled binary needs the `exec` mount flag — Docker sets `noexec` by default on tmpfs. Exit code 126 (permission denied on execution) confirmed this.

### MySQL Persistence Pattern
Identical to database buffer pool checkpointing:
- Y.Doc lives in memory for fast access
- `Y.encodeStateAsUpdate()` snapshots the document as binary every 30 seconds
- Snapshot saved to MySQL as LONGBLOB
- On room creation: load snapshot with `Y.applyUpdate()` — documents restored instantly
- On last user exit: immediate save before room is removed from memory

---

## Run Locally

### Prerequisites
- Node.js 18+
- Docker Desktop
- MySQL 8.0

### Setup

```bash
# Clone the repo
git clone https://github.com/Lalitkr2005/Collab-Editor.git
cd Collab-Editor

# Create MySQL database
mysql -u root -p
CREATE DATABASE collab_editor;
USE collab_editor;
CREATE TABLE IF NOT EXISTS room_snapshots (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  room_id    VARCHAR(255) NOT NULL UNIQUE,
  snapshot   LONGBLOB NOT NULL,
  language   VARCHAR(50) DEFAULT 'javascript',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
             ON UPDATE CURRENT_TIMESTAMP
);
EXIT;

# Install server dependencies
cd server
npm install

# Add your MySQL password to server/db.js
# Change: password: process.env.DB_PASSWORD || ''
# To:     password: process.env.DB_PASSWORD || 'your_password'
```

### Start

```bash
# Terminal 1 — WebSocket server
cd server
node index.js

# Terminal 2 — Client server
cd client
npx serve .
```

Open `http://localhost:3000` in two browser tabs. Join the same room in both and start typing.

### One Command (Docker Compose)

```bash
docker-compose up --build
```

Open `http://localhost:3000`

---

## Usage

1. Enter your name and a room name
2. Click **Join Room**
3. Share the URL with collaborators — they auto-join your room
4. Write code together in real time
5. Select a language from the dropdown (Python, JavaScript, C++)
6. Click **▶ Run** — output streams to everyone in the room

---

## Features Demonstrated

| Feature | How to see it |
|---|---|
| CRDT conflict-free sync | Open two tabs, type in both simultaneously |
| Live cursor presence | Move cursor in one tab, see colored label in other |
| Language sync | Change language in one tab, both switch instantly |
| Sandboxed execution | Run `import urllib.request; urllib.request.urlopen('http://google.com')` — network fails |
| Timeout protection | Run `while True: pass` — stops after 10 seconds |
| Persistence | Type code, wait 30s, restart server, rejoin room — code still there |

---

## What I Learned

Building this forced me to understand several concepts that frameworks abstract away:

**CRDTs vs Operational Transforms** — Why Yjs uses permanent character IDs instead of positions, and why this eliminates the need for a central server to serialize concurrent operations.

**Binary WebSocket protocol** — Why the first byte of every message encodes the type (sync/awareness/run/output) and why binary framing is more efficient than JSON wrapping.

**Linux namespace isolation** — How Docker's `--network none`, `--read-only`, and `--user` flags map to Linux kernel namespaces (network, filesystem, user) that make container isolation possible.

**Database checkpoint pattern** — Why keeping the Y.Doc in memory for fast access with periodic MySQL snapshots is identical to how database buffer pools handle durability.

---

## Related Projects

- [Vulnerability Scanner Agent](https://github.com/Lalitkr2005/Vulnerability-Scanner-Agent) — Autonomous AI security scanner using LangGraph and GPT-4o
