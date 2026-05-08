import { SECURITY_CONFIG } from '../rules.js';

const isPrivateOrLocalIp = (ip = '') =>
  /^(127\.|10\.|192\.168\.|::1$|::ffff:127\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(ip));

export const decideSecurityAction = ({ threatScore, ipReputation = {} }) => {
  const bannedUntil = ipReputation?.banned_until ? new Date(ipReputation.banned_until).getTime() : 0;
  if (ipReputation?.is_banned && bannedUntil > Date.now()) {
    return { actionTaken: 'block', blocked: true, shouldBan: false, reputationBlocked: true, reason: 'IP 已处于封禁期' };
  }
  if (!SECURITY_CONFIG.blockEnabled) {
    return { actionTaken: threatScore > 0 ? 'log' : 'allow', blocked: false, shouldBan: false, reason: '防护拦截未启用' };
  }
  if (threatScore >= 80) {
    const canBan = !isPrivateOrLocalIp(ipReputation?.ip);
    return {
      actionTaken: canBan ? 'ban' : 'block',
      blocked: true,
      shouldBan: canBan,
      reason: canBan ? '严重威胁，临时封禁' : '严重威胁，已拦截',
    };
  }
  if (threatScore >= 50) {
    return { actionTaken: 'block', blocked: true, shouldBan: false, reason: '高风险请求，已拦截' };
  }
  if (threatScore >= 20) {
    return { actionTaken: 'log', blocked: false, shouldBan: false, reason: '中等威胁，记录观察' };
  }
  if (threatScore > 0) {
    return { actionTaken: 'log', blocked: false, shouldBan: false, reason: '低风险可疑请求' };
  }
  return { actionTaken: 'allow', blocked: false, shouldBan: false, reason: '未发现威胁' };
};
