import pool from '../../db/index.js';
import { SIGNATURE_RULES } from './rules.js';

export const ensureSecurityTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(64) NOT NULL UNIQUE,
      attack_type VARCHAR(50) NOT NULL,
      severity ENUM('low','medium','high','critical') NOT NULL,
      threat_score INT DEFAULT 0,
      confidence INT DEFAULT 0,
      action_taken ENUM('log','allow','rate_limit','block','ban') DEFAULT 'log',
      blocked BOOLEAN DEFAULT FALSE,
      request_method VARCHAR(10),
      request_path VARCHAR(500),
      request_url TEXT,
      status_code INT,
      response_time_ms INT,
      source_ip VARCHAR(45),
      x_forwarded_for VARCHAR(500),
      user_agent VARCHAR(500),
      user_id VARCHAR(64),
      role VARCHAR(50),
      matched_rule VARCHAR(100),
      matched_payload TEXT,
      payload_summary JSON,
      headers_summary JSON,
      ip_attack_count_5m INT DEFAULT 0,
      ip_attack_count_24h INT DEFAULT 0,
      decision_reason VARCHAR(255),
      handled_status ENUM('unhandled','confirmed','false_positive','ignored','resolved') DEFAULT 'unhandled',
      handled_by VARCHAR(64),
      handled_at DATETIME,
      remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_type_time (attack_type, created_at),
      INDEX idx_ip_time (source_ip, created_at),
      INDEX idx_severity_time (severity, created_at),
      INDEX idx_score (threat_score),
      INDEX idx_user_time (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_event_evidence (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(64) NOT NULL,
      rule_code VARCHAR(100),
      rule_name VARCHAR(100),
      detector VARCHAR(50),
      attack_type VARCHAR(50),
      severity VARCHAR(20),
      matched_field VARCHAR(200),
      matched_value_preview TEXT,
      evidence_message TEXT,
      score_delta INT DEFAULT 0,
      confidence INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_event_id (event_id),
      INDEX idx_rule_code (rule_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_ip_reputation (
      ip VARCHAR(45) PRIMARY KEY,
      total_requests BIGINT DEFAULT 0,
      total_attacks INT DEFAULT 0,
      high_risk_count INT DEFAULT 0,
      critical_count INT DEFAULT 0,
      risk_score INT DEFAULT 0,
      attack_type_breakdown JSON,
      is_banned BOOLEAN DEFAULT FALSE,
      banned_until DATETIME,
      ban_reason VARCHAR(255),
      first_seen_at DATETIME,
      last_seen_at DATETIME,
      last_attack_time DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_risk_score (risk_score),
      INDEX idx_banned_until (banned_until)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_rules (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      rule_code VARCHAR(100) NOT NULL UNIQUE,
      rule_name VARCHAR(100) NOT NULL,
      attack_type VARCHAR(50) NOT NULL,
      severity ENUM('low','medium','high','critical') NOT NULL,
      base_score INT DEFAULT 0,
      confidence INT DEFAULT 0,
      action ENUM('log','allow','rate_limit','block','ban') DEFAULT 'log',
      enabled BOOLEAN DEFAULT TRUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_account_bans (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      banned_by VARCHAR(64),
      ban_reason VARCHAR(255),
      is_active BOOLEAN DEFAULT TRUE,
      banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      unbanned_by VARCHAR(64),
      unbanned_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_id (user_id),
      INDEX idx_active_time (is_active, banned_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  for (const rule of SIGNATURE_RULES) {
    await pool.query(
      `INSERT INTO security_rules
        (rule_code,rule_name,attack_type,severity,base_score,confidence,action,enabled,description)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        rule_name = VALUES(rule_name),
        attack_type = VALUES(attack_type),
        severity = VALUES(severity),
        base_score = VALUES(base_score),
        confidence = VALUES(confidence),
        updated_at = NOW()`,
      [
        rule.code,
        rule.name,
        rule.attackType,
        rule.severity,
        rule.baseScore,
        rule.confidence,
        rule.baseScore >= 50 ? 'block' : 'log',
        1,
        '系统内置安全检测规则',
      ],
    );
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSecurityTables()
    .then(() => {
      console.log('安全模块数据表已就绪');
      process.exit(0);
    })
    .catch((e) => {
      console.error('安全模块建表失败:', e.message);
      process.exit(1);
    });
}
