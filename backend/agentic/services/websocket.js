/**
 * websocket — Socket.IO handlers: session presence, typing indicators,
 * plan modifications, disconnect cleanup.
 *
 * Auth: every connection must present a valid `session` JWT cookie in the
 * handshake. The authenticated user id comes from the token — never from the
 * client payload — and join_session verifies the caller actually owns (or is
 * sharing) the session before joining its room.
 */
const jwt = require('jsonwebtoken');

let ioRef = null;
let poolRef = null;

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function initialize(io, dbPool) {
  ioRef = io;
  poolRef = dbPool;

  // Handshake gate: reject sockets without a valid session cookie.
  io.use(async (socket, next) => {
    try {
      const token = parseCookie(socket.handshake.headers?.cookie, 'session');
      if (!token) return next(new Error('unauthorized'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const result = await dbPool.query(
        'SELECT id, is_active, token_version FROM users WHERE id = $1',
        [payload.sub]
      );
      const user = result.rows[0];
      if (!user || !user.is_active) return next(new Error('unauthorized'));
      if ((payload.tv || 0) !== (user.token_version || 0)) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      next();
    } catch (_e) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    // Only allow joining a session the user owns or that is shared.
    async function canAccessSession(sessionId) {
      try {
        const r = await dbPool.query(
          `SELECT 1 FROM agent_chat_sessions
           WHERE id = $1 AND (user_id = $2 OR visibility = 'shared')`,
          [sessionId, userId]
        );
        return r.rows.length > 0;
      } catch (_e) {
        return false;
      }
    }

    socket.on('join_session', async ({ sessionId }) => {
      if (!sessionId) return;
      if (!(await canAccessSession(sessionId))) return;
      socket.join(`session:${sessionId}`);
      socket.data.sessionId = sessionId;
      try {
        await dbPool.query(
          `INSERT INTO agent_session_presence (session_id, user_id, socket_id, joined_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (socket_id) DO UPDATE SET session_id = $1, joined_at = NOW()`,
          [sessionId, userId, socket.id]
        );
      } catch (_e) { /* presence is best-effort */ }
      socket.to(`session:${sessionId}`).emit('user_joined', { userId });
    });

    socket.on('leave_session', ({ sessionId }) => {
      if (sessionId) socket.leave(`session:${sessionId}`);
    });

    socket.on('typing_start', ({ sessionId }) => {
      if (sessionId) socket.to(`session:${sessionId}`).emit('typing_start', { userId });
    });
    socket.on('typing_stop', ({ sessionId }) => {
      if (sessionId) socket.to(`session:${sessionId}`).emit('typing_stop', { userId });
    });

    socket.on('plan_modified', ({ sessionId, plan }) => {
      if (sessionId) socket.to(`session:${sessionId}`).emit('plan_modified', { plan, userId });
    });

    socket.on('disconnect', async () => {
      try {
        await dbPool.query('DELETE FROM agent_session_presence WHERE socket_id = $1', [socket.id]);
      } catch (_e) { /* ignore */ }
    });
  });

  console.log('🔌 WebSocket service initialized (authenticated)');
}

function broadcastToSession(sessionId, event, payload) {
  if (ioRef) ioRef.to(`session:${sessionId}`).emit(event, payload);
}

function sendNotificationToUser(userId, payload) {
  if (ioRef) ioRef.emit(`notification:${userId}`, payload);
}

module.exports = { initialize, broadcastToSession, sendNotificationToUser };
