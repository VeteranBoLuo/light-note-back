import pool from '../db/index.js';
import { resultData } from '../util/common.js';
import { validateQueryParams } from '../util/request.js';
import { rebuildIpReputationFromEvents, revertIpReputationImpact, setIpBan } from '../util/security/services/ipReputation.js';
import { rebuildAccountReputationFromEvents, revertAccountReputationImpact } from '../util/security/services/accountReputation.js';
import { removeUserSessions } from '../util/sessionStore.js';

const ensureRootRole = async (req, res) => {
  if (!req.user?.id || req.user?.role !== 'root') {
    res.send(resultData(null, 403, '仅root用户可查看安全中心'));
    return false;
  }
  return true;
};

const parseJsonField = (row, field, fallback) => {
  if (!row || row[field] === undefined || row[field] === null) return;
  if (typeof row[field] === 'object') return;
  try {
    row[field] = JSON.parse(row[field]);
  } catch (e) {
    row[field] = fallback;
  }
};

const buildEventWhere = (filters = {}) => {
  const conditions = ['1=1'];
  const params = [];
  if (filters.key) {
    conditions.push(
      `(e.source_ip LIKE CONCAT('%', ?, '%')
        OR e.request_path LIKE CONCAT('%', ?, '%')
        OR e.attack_type LIKE CONCAT('%', ?, '%')
        OR e.user_agent LIKE CONCAT('%', ?, '%')
        OR u.alias LIKE CONCAT('%', ?, '%')
        OR u.email LIKE CONCAT('%', ?, '%'))`,
    );
    params.push(filters.key, filters.key, filters.key, filters.key, filters.key, filters.key);
  }
  if (filters.attack_type) {
    conditions.push('e.attack_type = ?');
    params.push(filters.attack_type);
  }
  if (filters.severity) {
    conditions.push('e.severity = ?');
    params.push(filters.severity);
  }
  if (filters.action_taken) {
    conditions.push('e.action_taken = ?');
    params.push(filters.action_taken);
  }
  if (filters.handled_status) {
    conditions.push('e.handled_status = ?');
    params.push(filters.handled_status);
  }
  if (filters.source_ip) {
    conditions.push('e.source_ip = ?');
    params.push(filters.source_ip);
  }
  if (filters.user_id) {
    conditions.push('e.user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.blocked !== undefined && filters.blocked !== '' && filters.blocked !== null) {
    conditions.push('e.blocked = ?');
    params.push(Number(filters.blocked));
  }
  if (filters.start_time) {
    conditions.push('e.created_at >= ?');
    params.push(filters.start_time);
  }
  if (filters.end_time) {
    conditions.push('e.created_at <= ?');
    params.push(filters.end_time);
  }
  return { where: conditions.join(' AND '), params };
};

export const getSecurityOverview = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const [summaryRows] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(severity IN ('high','critical')) AS highRisk,
        SUM(blocked = 1) AS blocked,
        COUNT(DISTINCT source_ip) AS activeIps,
        SUM(created_at >= CURDATE()) AS todayTotal,
        SUM(created_at >= CURDATE() AND severity = 'critical') AS todayCritical
      FROM security_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);
    const [typeRows] = await pool.query(`
      SELECT attack_type AS attackType, COUNT(*) AS total
      FROM security_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY attack_type
      ORDER BY total DESC
      LIMIT 8
    `);
    const [trendRows] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%m-%d %H:00') AS time, COUNT(*) AS total, SUM(blocked = 1) AS blocked
      FROM security_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d %H')
      ORDER BY MIN(created_at)
    `);
    const [topIpRows] = await pool.query(`
      SELECT source_ip AS sourceIp, COUNT(*) AS total, MAX(threat_score) AS maxScore
      FROM security_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY source_ip
      ORDER BY total DESC
      LIMIT 8
    `);
    const [topPathRows] = await pool.query(`
      SELECT request_path AS requestPath, COUNT(*) AS total, MAX(threat_score) AS maxScore
      FROM security_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY request_path
      ORDER BY total DESC
      LIMIT 8
    `);
    const [recentRows] = await pool.query(`
      SELECT e.*, u.alias, u.email
      FROM security_events e
      LEFT JOIN user u ON e.user_id = u.id
      ORDER BY e.created_at DESC
      LIMIT 8
    `);
    res.send(
      resultData({
        summary: summaryRows[0],
        typeDistribution: typeRows,
        trend: trendRows,
        topIps: topIpRows,
        topPaths: topPathRows,
        recentEvents: recentRows,
      }),
    );
  } catch (e) {
    res.send(resultData(null, 500, '获取安全总览失败：' + e.message));
  }
};

export const getSecurityEvents = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const skip = pageSize * (currentPage - 1);
    const { where, params } = buildEventWhere(filters);
    const [rows] = await pool.query(
      `SELECT e.*, u.alias, u.email
       FROM security_events e
       LEFT JOIN user u ON e.user_id = u.id
       WHERE ${where}
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), Number(skip)],
    );
    rows.forEach((row) => {
      parseJsonField(row, 'payload_summary', {});
      parseJsonField(row, 'headers_summary', {});
    });
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM security_events e
       LEFT JOIN user u ON e.user_id = u.id
       WHERE ${where}`,
      params,
    );
    res.send(resultData({ items: rows, total: totalRows[0].total }));
  } catch (e) {
    res.send(resultData(null, 500, '获取安全事件失败：' + e.message));
  }
};

export const getSecurityEventDetail = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { eventId } = req.params;
    const [rows] = await pool.query(
      `SELECT e.*, u.alias, u.email
       FROM security_events e
       LEFT JOIN user u ON e.user_id = u.id
       WHERE e.event_id = ?
       LIMIT 1`,
      [eventId],
    );
    if (!rows[0]) {
      return res.send(resultData(null, 404, '安全事件不存在'));
    }
    const event = rows[0];
    parseJsonField(event, 'payload_summary', {});
    parseJsonField(event, 'headers_summary', {});
    const [evidence] = await pool.query(
      `SELECT *
       FROM security_event_evidence
       WHERE event_id = ?
       ORDER BY score_delta DESC, id ASC`,
      [eventId],
    );
    const [ipRecent] = await pool.query(
      `SELECT event_id, attack_type, severity, threat_score, request_path, action_taken, created_at
       FROM security_events
       WHERE source_ip = ?
       ORDER BY created_at DESC
       LIMIT 12`,
      [event.source_ip],
    );
    const [ipInfo] = await pool.query('SELECT * FROM security_ip_reputation WHERE ip = ? LIMIT 1', [event.source_ip]);
    if (ipInfo[0]) parseJsonField(ipInfo[0], 'attack_type_breakdown', {});
    let userInfo = null;
    if (event.user_id) {
      const [uRows] = await pool.query('SELECT * FROM security_account_reputation WHERE user_id = ? LIMIT 1', [event.user_id]);
      if (uRows[0]) {
        userInfo = uRows[0];
        parseJsonField(userInfo, 'attack_type_breakdown', {});
      }
    }
    res.send(resultData({ event, evidence, ipRecent, ipInfo: ipInfo[0] || null, userInfo }));
  } catch (e) {
    res.send(resultData(null, 500, '获取安全事件详情失败：' + e.message));
  }
};

export const handleSecurityEvent = async (req, res) => {
  let connection;
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { eventId } = req.params;
    const { handledStatus = 'processed', remark = '' } = req.body || {};
    const statusMap = {
      confirmed: 'processed',
      resolved: 'processed',
      ignored: 'processed',
      processed: 'processed',
      false_positive: 'false_positive',
      unhandled: 'unhandled',
    };
    const normalizedStatus = statusMap[handledStatus];
    const allowed = ['unhandled', 'processed', 'false_positive'];
    if (!allowed.includes(normalizedStatus)) {
      return res.send(resultData(null, 400, '无效的处理状态'));
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query('SELECT * FROM security_events WHERE event_id = ? LIMIT 1 FOR UPDATE', [eventId]);
    const event = rows[0];
    if (!event) {
      await connection.rollback();
      return res.send(resultData(null, 404, '安全事件不存在'));
    }

    await connection.query(
      `UPDATE security_events
       SET handled_status = ?, remark = ?, handled_by = ?, handled_at = NOW()
       WHERE event_id = ?`,
      [normalizedStatus, remark, req.user.id, eventId],
    );

    if (normalizedStatus === 'false_positive' && !event.ip_risk_reverted) {
      if (Number(event.ip_risk_delta || 0) > 0) {
        await revertIpReputationImpact({
          ip: event.source_ip,
          attackType: event.attack_type,
          severity: event.severity,
          riskDelta: event.ip_risk_delta,
          connection,
        });
      } else {
        await rebuildIpReputationFromEvents({ ip: event.source_ip, connection });
      }
      await connection.query(
        `UPDATE security_events
         SET ip_risk_reverted = 1, ip_risk_reverted_at = NOW()
         WHERE event_id = ?`,
        [eventId],
      );
    }
    if (normalizedStatus === 'false_positive' && event.user_id && !event.user_risk_reverted) {
      if (Number(event.user_risk_delta || 0) > 0) {
        await revertAccountReputationImpact({
          userId: event.user_id,
          attackType: event.attack_type,
          severity: event.severity,
          riskDelta: event.user_risk_delta,
          connection,
        });
      } else {
        await rebuildAccountReputationFromEvents({ userId: event.user_id, connection });
      }
      await connection.query(
        `UPDATE security_events
         SET user_risk_reverted = 1, user_risk_reverted_at = NOW()
         WHERE event_id = ?`,
        [eventId],
      );
    }
    await connection.commit();
    res.send(resultData(null, 200, normalizedStatus === 'false_positive' ? '已标记误报并回滚风险影响' : '处理状态已更新'));
  } catch (e) {
    if (connection) await connection.rollback().catch(() => {});
    res.send(resultData(null, 500, '更新处理状态失败：' + e.message));
  } finally {
    if (connection) connection.release();
  }
};

export const getIpReputationList = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const skip = pageSize * (currentPage - 1);
    const where = filters.key ? 'WHERE ip LIKE CONCAT("%", ?, "%") OR ban_reason LIKE CONCAT("%", ?, "%")' : '';
    const params = filters.key ? [filters.key, filters.key] : [];
    const [rows] = await pool.query(
      `SELECT *
       FROM security_ip_reputation
       ${where}
       ORDER BY is_banned DESC, risk_score DESC, total_attacks DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), Number(skip)],
    );
    rows.forEach((row) => parseJsonField(row, 'attack_type_breakdown', {}));
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS total FROM security_ip_reputation ${where}`, params);
    res.send(resultData({ items: rows, total: totalRows[0].total }));
  } catch (e) {
    res.send(resultData(null, 500, '获取IP画像失败：' + e.message));
  }
};

export const banIp = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { ip, minutes = 60, reason = '管理员手动封禁' } = req.body || {};
    if (!ip) return res.send(resultData(null, 400, 'IP不能为空'));
    await setIpBan(ip, true, minutes, reason);
    res.send(resultData(null, 200, 'IP已封禁'));
  } catch (e) {
    res.send(resultData(null, 500, '封禁IP失败：' + e.message));
  }
};

export const unbanIp = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { ip } = req.body || {};
    if (!ip) return res.send(resultData(null, 400, 'IP不能为空'));
    await setIpBan(ip, false, 0, '');
    res.send(resultData(null, 200, 'IP已解封'));
  } catch (e) {
    res.send(resultData(null, 500, '解封IP失败：' + e.message));
  }
};

export const getIpAccounts = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { ip } = req.body || {};
    if (!ip) return res.send(resultData(null, 400, 'IP不能为空'));
    const [rows] = await pool.query(
      `SELECT
         account_usage.user_id,
         u.alias,
         u.email,
         u.role,
         u.del_flag,
         SUM(account_usage.security_events) AS security_events,
         SUM(account_usage.api_requests) AS api_requests,
         MAX(account_usage.last_seen_at) AS last_seen_at,
         GROUP_CONCAT(DISTINCT account_usage.source ORDER BY account_usage.source SEPARATOR '、') AS sources
       FROM (
         SELECT user_id, COUNT(*) AS security_events, 0 AS api_requests, MAX(created_at) AS last_seen_at, '安全事件' AS source
         FROM security_events
         WHERE source_ip = ? AND user_id IS NOT NULL AND user_id <> ''
         GROUP BY user_id
         UNION ALL
         SELECT user_id, 0 AS security_events, COUNT(*) AS api_requests, MAX(request_time) AS last_seen_at, '访问日志' AS source
         FROM api_logs
         WHERE ip = ? AND user_id IS NOT NULL AND user_id <> '' AND del_flag = 0
         GROUP BY user_id
       ) account_usage
       LEFT JOIN user u ON account_usage.user_id = u.id
       GROUP BY account_usage.user_id, u.alias, u.email, u.role, u.del_flag
       ORDER BY last_seen_at DESC
       LIMIT 100`,
      [ip, ip],
    );
    res.send(resultData({ items: rows, total: rows.length }));
  } catch (e) {
    res.send(resultData(null, 500, '获取IP关联账号失败：' + e.message));
  }
};

export const getAccountBanList = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const skip = pageSize * (currentPage - 1);
    const params = [];
    const conditions = ['u.del_flag = 1'];
    if (filters.key) {
      conditions.push('(u.id LIKE CONCAT("%", ?, "%") OR u.alias LIKE CONCAT("%", ?, "%") OR u.email LIKE CONCAT("%", ?, "%") OR b.ban_reason LIKE CONCAT("%", ?, "%"))');
      params.push(filters.key, filters.key, filters.key, filters.key);
    }
    const where = conditions.join(' AND ');
    const [rows] = await pool.query(
      `SELECT
         u.id AS user_id,
         u.alias,
         u.email,
         u.role,
         u.head_picture,
         b.ban_reason,
         b.banned_by,
         b.banned_at,
         b.unbanned_at,
         b.updated_at,
         r.risk_score,
         r.total_events,
         r.high_risk_count,
         r.critical_count,
         r.last_event_at
       FROM user u
       LEFT JOIN security_account_bans b ON b.user_id = u.id
       LEFT JOIN security_account_reputation r ON r.user_id = u.id
       WHERE ${where}
       ORDER BY COALESCE(b.banned_at, u.create_time) DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), Number(skip)],
    );
    rows.forEach((row) => parseJsonField(row, 'attack_type_breakdown', {}));
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM user u
       LEFT JOIN security_account_bans b ON b.user_id = u.id
       WHERE ${where}`,
      params,
    );
    res.send(resultData({ items: rows, total: totalRows[0].total }));
  } catch (e) {
    res.send(resultData(null, 500, '获取账号封禁列表失败：' + e.message));
  }
};

export const getAccountReputationList = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const skip = pageSize * (currentPage - 1);
    const params = [];
    const conditions = [];
    if (filters.key) {
      conditions.push(
        '(u.id LIKE CONCAT("%", ?, "%") OR u.alias LIKE CONCAT("%", ?, "%") OR u.email LIKE CONCAT("%", ?, "%"))',
      );
      params.push(filters.key, filters.key, filters.key);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT
         u.id AS user_id,
         u.alias,
         u.email,
         u.role,
         u.head_picture,
         u.del_flag,
         r.risk_score,
         r.total_events,
         r.high_risk_count,
         r.critical_count,
         r.last_event_at
       FROM user u
       LEFT JOIN security_account_reputation r ON r.user_id = u.id
       ${where}
       ORDER BY u.del_flag DESC, COALESCE(r.risk_score, 0) DESC, u.create_time DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), Number(skip)],
    );
    rows.forEach((row) => parseJsonField(row, 'attack_type_breakdown', {}));
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM user u
       LEFT JOIN security_account_reputation r ON r.user_id = u.id
       ${where}`,
      params,
    );
    res.send(resultData({ items: rows, total: totalRows[0].total }));
  } catch (e) {
    res.send(resultData(null, 500, '获取账号画像失败：' + e.message));
  }
};

export const banAccount = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { userId, reason = '管理员在安全中心手动封禁' } = req.body || {};
    if (!userId) return res.send(resultData(null, 400, '账号不能为空'));
    if (userId === req.user.id) return res.send(resultData(null, 400, '不能封禁当前登录账号'));
    const [rows] = await pool.query('SELECT id, role, del_flag FROM user WHERE id = ? LIMIT 1', [userId]);
    if (!rows[0]) return res.send(resultData(null, 404, '账号不存在'));
    await pool.query('UPDATE user SET del_flag = 1 WHERE id = ?', [userId]);
    await pool.query(
      `INSERT INTO security_account_bans (user_id,banned_by,ban_reason,is_active,banned_at)
       VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
        banned_by = VALUES(banned_by),
        ban_reason = VALUES(ban_reason),
        is_active = 1,
        banned_at = NOW(),
        unbanned_by = NULL,
        unbanned_at = NULL,
        updated_at = NOW()`,
      [userId, req.user.id, reason, 1],
    );
    await removeUserSessions(userId);
    res.send(resultData(null, 200, '账号已封禁'));
  } catch (e) {
    res.send(resultData(null, 500, '封禁账号失败：' + e.message));
  }
};

export const unbanAccount = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const { userId } = req.body || {};
    if (!userId) return res.send(resultData(null, 400, '账号不能为空'));
    await pool.query('UPDATE user SET del_flag = 0 WHERE id = ?', [userId]);
    await pool.query(
      `UPDATE security_account_bans
       SET is_active = 0, unbanned_by = ?, unbanned_at = NOW(), updated_at = NOW()
       WHERE user_id = ?`,
      [req.user.id, userId],
    );
    res.send(resultData(null, 200, '账号已解封'));
  } catch (e) {
    res.send(resultData(null, 500, '解封账号失败：' + e.message));
  }
};

export const getSecurityRules = async (req, res) => {
  try {
    if (!(await ensureRootRole(req, res))) return;
    const [rows] = await pool.query('SELECT * FROM security_rules ORDER BY attack_type, base_score DESC');
    res.send(resultData({ items: rows, total: rows.length }));
  } catch (e) {
    res.send(resultData(null, 500, '获取安全规则失败：' + e.message));
  }
};
