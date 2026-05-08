import pool from '../../../db/index.js';

const cache = new Map();
const CACHE_TTL = 60 * 1000;

const defaultReputation = (ip) => ({
  ip,
  total_requests: 0,
  total_attacks: 0,
  high_risk_count: 0,
  critical_count: 0,
  risk_score: 0,
  attack_type_breakdown: {},
  is_banned: 0,
  banned_until: null,
});

export const getIpReputation = async (ip) => {
  if (!ip) return defaultReputation('');
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const [rows] = await pool.query('SELECT * FROM security_ip_reputation WHERE ip = ? LIMIT 1', [ip]);
    const value = rows[0] || defaultReputation(ip);
    if (typeof value.attack_type_breakdown === 'string') {
      try {
        value.attack_type_breakdown = JSON.parse(value.attack_type_breakdown || '{}');
      } catch (e) {
        value.attack_type_breakdown = {};
      }
    }
    cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL });
    return value;
  } catch (e) {
    return defaultReputation(ip);
  }
};

export const updateIpReputation = async ({ ip, attackType, severity, threatScore, shouldBan = false, banMinutes = 30 }) => {
  if (!ip) return;
  const current = await getIpReputation(ip);
  const breakdown = current.attack_type_breakdown || {};
  breakdown[attackType] = Number(breakdown[attackType] || 0) + 1;
  const highRisk = ['high', 'critical'].includes(severity) ? 1 : 0;
  const critical = severity === 'critical' ? 1 : 0;
  const nextRiskScore = Math.min(100, Number(current.risk_score || 0) + Math.max(3, Math.ceil(Number(threatScore || 0) / 10)));
  const bannedUntil = shouldBan ? new Date(Date.now() + banMinutes * 60 * 1000) : current.banned_until;
  const isBanned = shouldBan ? 1 : Number(current.is_banned || 0);

  await pool.query(
    `INSERT INTO security_ip_reputation
      (ip,total_attacks,high_risk_count,critical_count,risk_score,is_banned,banned_until,ban_reason,attack_type_breakdown,first_seen_at,last_seen_at,last_attack_time)
     VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW(),NOW())
     ON DUPLICATE KEY UPDATE
      total_attacks = total_attacks + 1,
      high_risk_count = high_risk_count + VALUES(high_risk_count),
      critical_count = critical_count + VALUES(critical_count),
      risk_score = VALUES(risk_score),
      is_banned = VALUES(is_banned),
      banned_until = VALUES(banned_until),
      ban_reason = VALUES(ban_reason),
      attack_type_breakdown = VALUES(attack_type_breakdown),
      last_seen_at = NOW(),
      last_attack_time = NOW()`,
    [
      ip,
      1,
      highRisk,
      critical,
      nextRiskScore,
      isBanned,
      bannedUntil,
      shouldBan ? `${attackType} 威胁分 ${threatScore}` : current.ban_reason || '',
      JSON.stringify(breakdown),
    ],
  );
  cache.delete(ip);
};

export const recordIpRequest = async (ip) => {
  if (!ip) return;
  pool
    .query(
      `INSERT INTO security_ip_reputation (ip,total_requests,first_seen_at,last_seen_at)
       VALUES (?,1,NOW(),NOW())
       ON DUPLICATE KEY UPDATE total_requests = total_requests + 1, last_seen_at = NOW()`,
      [ip],
    )
    .catch(() => {});
};

export const setIpBan = async (ip, banned, minutes = 60, reason = '') => {
  const bannedUntil = banned ? new Date(Date.now() + Number(minutes || 60) * 60 * 1000) : null;
  await pool.query(
    `INSERT INTO security_ip_reputation (ip,is_banned,banned_until,ban_reason,first_seen_at,last_seen_at)
     VALUES (?,?,?,?,NOW(),NOW())
     ON DUPLICATE KEY UPDATE is_banned = VALUES(is_banned), banned_until = VALUES(banned_until), ban_reason = VALUES(ban_reason), last_seen_at = NOW()`,
    [ip, banned ? 1 : 0, bannedUntil, reason],
  );
  cache.delete(ip);
};
