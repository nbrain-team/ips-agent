/**
 * websocket — Socket.IO handlers: session presence, typing indicators,
 * plan modifications, disconnect cleanup. Safe to keep even single-user.
 */

let ioRef = null;
let poolRef = null;

function initialize(io, dbPool) {
  ioRef = io;
  poolRef = dbPool;

  io.on('connection', (socket) => {
    socket.on('join_session', async ({ sessionId, userId }) => {
      if (!sessionId) return;
      socket.join(`session:${sessionId}`);
      socket.data.sessionId = sessionId;
      socket.data.userId = userId;
      try {
        await dbPool.query(
          `INSERT INTO agent_session_presence (session_id, user_id, socket_id, joined_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (socket_id) DO UPDATE SET session_id = $1, joined_at = NOW()`,
          [sessionId, userId || null, socket.id]
        );
      } catch (_e) { /* presence is best-effort */ }
      socket.to(`session:${sessionId}`).emit('user_joined', { userId });
    });

    socket.on('leave_session', ({ sessionId }) => {
      if (sessionId) socket.leave(`session:${sessionId}`);
    });

    socket.on('typing_start', ({ sessionId, userId }) => {
      if (sessionId) socket.to(`session:${sessionId}`).emit('typing_start', { userId });
    });
    socket.on('typing_stop', ({ sessionId, userId }) => {
      if (sessionId) socket.to(`session:${sessionId}`).emit('typing_stop', { userId });
    });

    socket.on('plan_modified', ({ sessionId, plan, userId }) => {
      if (sessionId) socket.to(`session:${sessionId}`).emit('plan_modified', { plan, userId });
    });

    socket.on('disconnect', async () => {
      try {
        await dbPool.query('DELETE FROM agent_session_presence WHERE socket_id = $1', [socket.id]);
      } catch (_e) { /* ignore */ }
    });
  });

  console.log('🔌 WebSocket service initialized');
}

function broadcastToSession(sessionId, event, payload) {
  if (ioRef) ioRef.to(`session:${sessionId}`).emit(event, payload);
}

function sendNotificationToUser(userId, payload) {
  if (ioRef) ioRef.emit(`notification:${userId}`, payload);
}

module.exports = { initialize, broadcastToSession, sendNotificationToUser };
