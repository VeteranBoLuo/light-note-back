import crypto from 'crypto';
import pool from '../db/index.js';


export const createSessionId = () => crypto.randomBytes(32).toString('hex');


export const createSession = async ({ userId, role, maxAgeMs, ip = '', userAgent = '' }) => {
  const sid = createSessionId();
  const maxAgeSeconds = Math.max(1, Math.ceil(maxAgeMs / 1000));
  await pool.query(
    `INSERT INTO user_sessions (sid, user_id, role, expires_at, ip, user_agent)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?, ?)`,
    [sid, userId, role || 'visitor', maxAgeSeconds, ip, userAgent],
  );
  return { sid };
};

export const getSession = async (sid) => {
  if (!sid) return null;
  const [rows] = await pool.query(
    `SELECT
       sid,
       user_id,
       role,
       expires_at,
       GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), expires_at)) AS expires_in_seconds
     FROM user_sessions
     WHERE sid = ? AND expires_at > NOW()
     LIMIT 1`,
    [sid],
  );
  const session = rows[0];
  if (!session) {
    await removeSession(sid);
    return null;
  }

  // 滑动过期策略：剩余不足 24h 时延长到 24h，让活跃用户不掉线
  const ONE_DAY_SEC = 86400;
  if (session.expires_in_seconds < ONE_DAY_SEC) {
    await pool.query(
      `UPDATE user_sessions
       SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
           last_active_time = NOW()
       WHERE sid = ?`,
      [ONE_DAY_SEC, sid],
    );
    session.expires_in_seconds = ONE_DAY_SEC;
  } else {
    await pool.query('UPDATE user_sessions SET last_active_time = NOW() WHERE sid = ?', [sid]);
  }

  return session;
};

export const removeSession = async (sid) => {
  if (!sid) return;
  await pool.query('DELETE FROM user_sessions WHERE sid = ?', [sid]);
};

export const removeUserSessions = async (userId) => {
  if (!userId) return;
  await pool.query('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
};

export const cleanupExpiredSessions = async () => {
  await pool.query('DELETE FROM user_sessions WHERE expires_at <= NOW()');
};
