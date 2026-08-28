const mysql = require('mysql2/promise');

// Connection pool. Credentials come from environment variables when running
// under Docker Compose, and fall back to a local MySQL install otherwise.
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || 'Lalit@2005',
  database: process.env.DB_NAME     || 'collab_editor',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Upsert a room's Yjs snapshot. room_id has a UNIQUE constraint, so a second
// save for the same room updates the existing row instead of inserting.
async function saveSnapshot(roomId, snapshotBuffer, language) {
  const buffer = Buffer.isBuffer(snapshotBuffer)
    ? snapshotBuffer
    : Buffer.from(snapshotBuffer);

  await pool.execute(
    `INSERT INTO room_snapshots (room_id, snapshot, language)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       snapshot = VALUES(snapshot),
       language = VALUES(language)`,
    [roomId, buffer, language || 'javascript']
  );
}

// Return { snapshot, language } for a room, or null if it has never been saved.
async function loadSnapshot(roomId) {
  const [rows] = await pool.execute(
    `SELECT snapshot, language FROM room_snapshots WHERE room_id = ? LIMIT 1`,
    [roomId]
  );

  if (rows.length === 0) return null;

  return {
    snapshot: rows[0].snapshot,
    language: rows[0].language,
  };
}

// Ping MySQL once at startup so failures are visible in the logs immediately.
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('[db] MySQL connection successful');
    return true;
  } catch (error) {
    console.error(`[db] MySQL connection failed: ${error.message}`);
    return false;
  }
}

module.exports = { pool, saveSnapshot, loadSnapshot, testConnection };
