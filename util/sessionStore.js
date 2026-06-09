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
       create_time,
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

  // 通过 expires_at - create_time 判断原始有效期是否为 7 天（记住我）
  const SEVEN_DAY_MS = 604800000; // 7 * 24 * 60 * 60 * 1000
  const isRememberMe = (session.expires_at.getTime() - session.create_time.getTime()) >= SEVEN_DAY_MS;

  if (isRememberMe) {
    // 记住我用户：每次使用续回 7 天
    const SEVEN_DAY_SEC = 604800;
    await pool.query(
      `UPDATE user_sessions
       SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
           last_active_time = NOW()
       WHERE sid = ?`,
      [SEVEN_DAY_SEC, sid],
    );
    session.expires_in_seconds = SEVEN_DAY_SEC;
  } else {
    // 普通登录：滑动过期，不足 24h 时续 24h
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
