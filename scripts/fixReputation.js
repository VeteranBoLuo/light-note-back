/**
 * 修复因竞态条件导致不准确的 IP/账号 风险分数
 * 用法: node scripts/fixReputation.js
 */
import pool from '../db/index.js';
import { rebuildIpReputationFromEvents } from '../util/security/services/ipReputation.js';
import { rebuildAccountReputationFromEvents } from '../util/security/services/accountReputation.js';

const main = async () => {
  console.log('正在获取需要修复的 IP 列表...');
  const [ipRows] = await pool.query(
    `SELECT DISTINCT source_ip AS ip
     FROM security_events
     WHERE threat_score >= 20
       AND handled_status <> 'false_positive'`,
  );
  console.log(`找到 ${ipRows.length} 个 IP`);

  for (const row of ipRows) {
    try {
      await rebuildIpReputationFromEvents({ ip: row.ip });
      console.log(`  [OK] IP ${row.ip} 重建完成`);
    } catch (e) {
      console.error(`  [FAIL] IP ${row.ip}: ${e.message}`);
    }
  }

  console.log('正在获取需要修复的账号列表...');
  const [acctRows] = await pool.query(
    `SELECT DISTINCT user_id AS userId
     FROM security_events
     WHERE threat_score >= 20
       AND handled_status <> 'false_positive'
       AND user_id IS NOT NULL AND user_id <> ''`,
  );
  console.log(`找到 ${acctRows.length} 个账号`);

  for (const row of acctRows) {
    try {
      await rebuildAccountReputationFromEvents({ userId: row.userId });
      console.log(`  [OK] 账号 ${row.userId} 重建完成`);
    } catch (e) {
      console.error(`  [FAIL] 账号 ${row.userId}: ${e.message}`);
    }
  }

  console.log('修复完成');
  process.exit(0);
};

main().catch((e) => {
  console.error('修复脚本失败:', e);
  process.exit(1);
});
