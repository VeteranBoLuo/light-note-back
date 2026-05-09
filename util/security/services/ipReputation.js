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

const parseAttackTypeBreakdown = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch (e) {
    return {};
  }
};

export const getIpReputation = async (ip) => {
  if (!ip) return defaultReputation('');
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const [rows] = await pool.query('SELECT * FROM security_ip_reputation WHERE ip = ? LIMIT 1', [ip]);
    const value = rows[0] || defaultReputation(ip);
    value.attack_type_breakdown = parseAttackTypeBreakdown(value.attack_type_breakdown);
    cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL });
    return value;
  } catch (e) {
    return defaultReputation(ip);
  }
};

export const updateIpReputation = async ({ ip, attackType, severity, threatScore, shouldBan = false, banMinutes = 30 }) => {
  if (!ip) return { riskDelta: 0 };
  const current = await getIpReputation(ip);
  const breakdown = current.attack_type_breakdown || {};
  breakdown[attackType] = Number(breakdown[attackType] || 0) + 1;
  const highRisk = ['high', 'critical'].includes(severity) ? 1 : 0;
  const critical = severity === 'critical' ? 1 : 0;
  const currentRiskScore = Number(current.risk_score || 0);
  const theoreticalRiskDelta = Math.max(3, Math.ceil(Number(threatScore || 0) / 10));
  const nextRiskScore = Math.min(100, currentRiskScore + theoreticalRiskDelta);
  const riskDelta = Math.max(0, nextRiskScore - currentRiskScore);
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
  return { riskDelta, theoreticalRiskDelta, nextRiskScore, highRisk, critical };
};

export const revertIpReputationImpact = async ({ ip, attackType, severity, riskDelta = 0, connection = null }) => {
  if (!ip) return false;
  const executor = connection || pool;
  const [rows] = await executor.query('SELECT * FROM security_ip_reputation WHERE ip = ? LIMIT 1', [ip]);
  const current = rows[0];
  if (!current) {
    cache.delete(ip);
    return false;
  }

  const breakdown = parseAttackTypeBreakdown(current.attack_type_breakdown);
  if (attackType) {
    const nextTypeCount = Math.max(0, Number(breakdown[attackType] || 0) - 1);
    if (nextTypeCount > 0) {
      breakdown[attackType] = nextTypeCount;
    } else {
      delete breakdown[attackType];
    }
  }

  const highRisk = ['high', 'critical'].includes(severity) ? 1 : 0;
  const critical = severity === 'critical' ? 1 : 0;
  await executor.query(
    `UPDATE security_ip_reputation
     SET total_attacks = GREATEST(0, total_attacks - 1),
         high_risk_count = GREATEST(0, high_risk_count - ?),
         critical_count = GREATEST(0, critical_count - ?),
         risk_score = GREATEST(0, risk_score - ?),
         attack_type_breakdown = ?,
         last_seen_at = NOW()
     WHERE ip = ?`,
    [highRisk, critical, Math.max(0, Number(riskDelta || 0)), JSON.stringify(breakdown), ip],
  );
  cache.delete(ip);
  return true;
};

export const rebuildIpReputationFromEvents = async ({ ip, connection = null }) => {
  if (!ip) return false;
  const executor = connection || pool;
  const [currentRows] = await executor.query('SELECT * FROM security_ip_reputation WHERE ip = ? LIMIT 1', [ip]);
  const current = currentRows[0] || defaultReputation(ip);
  const [events] = await executor.query(
    `SELECT attack_type, severity, threat_score, ip_risk_delta, created_at
     FROM security_events
     WHERE source_ip = ?
       AND handled_status <> 'false_positive'
       AND COALESCE(ip_risk_reverted, 0) = 0
       AND threat_score >= 20
     ORDER BY created_at ASC, id ASC`,
    [ip],
  );

  let riskScore = 0;
  let highRiskCount = 0;
  let criticalCount = 0;
  let lastAttackTime = null;
  const breakdown = {};

  for (const event of events) {
    const attackType = event.attack_type || 'SUSPICIOUS_REQUEST';
    const severity = event.severity || 'low';
    const storedDelta = Number(event.ip_risk_delta || 0);
    const theoreticalDelta = Math.max(3, Math.ceil(Number(event.threat_score || 0) / 10));
    const actualDelta = storedDelta > 0 ? storedDelta : Math.min(100, riskScore + theoreticalDelta) - riskScore;
    riskScore = Math.min(100, riskScore + Math.max(0, actualDelta));
    breakdown[attackType] = Number(breakdown[attackType] || 0) + 1;
    if (['high', 'critical'].includes(severity)) highRiskCount += 1;
    if (severity === 'critical') criticalCount += 1;
    lastAttackTime = event.created_at;
  }

  await executor.query(
    `INSERT INTO security_ip_reputation
      (ip,total_requests,total_attacks,high_risk_count,critical_count,risk_score,attack_type_breakdown,is_banned,banned_until,ban_reason,first_seen_at,last_seen_at,last_attack_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,COALESCE(?,NOW()),NOW(),?)
     ON DUPLICATE KEY UPDATE
      total_attacks = VALUES(total_attacks),
      high_risk_count = VALUES(high_risk_count),
      critical_count = VALUES(critical_count),
      risk_score = VALUES(risk_score),
      attack_type_breakdown = VALUES(attack_type_breakdown),
      last_seen_at = NOW(),
      last_attack_time = VALUES(last_attack_time)`,
    [
      ip,
      Number(current.total_requests || 0),
      events.length,
      highRiskCount,
      criticalCount,
      riskScore,
      JSON.stringify(breakdown),
      Number(current.is_banned || 0),
      current.banned_until || null,
      current.ban_reason || null,
      current.first_seen_at || null,
      lastAttackTime,
    ],
  );
  cache.delete(ip);
  return true;
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
