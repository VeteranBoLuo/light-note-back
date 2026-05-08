const severityWeight = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const getSeverityByScore = (score) => {
  if (score >= 80) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
};

export const calculateThreat = (evidenceList = [], ipReputation = {}) => {
  const evidenceScore = evidenceList.reduce((sum, item) => sum + Number(item.scoreDelta || 0), 0);
  const confidence = evidenceList.length
    ? Math.round(evidenceList.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / evidenceList.length)
    : 0;
  const reputationScore = Math.min(30, Math.floor(Number(ipReputation.risk_score || 0) / 4));
  const score = Math.min(100, evidenceScore + reputationScore);
  const strongestEvidence = [...evidenceList].sort((a, b) => {
    const severityDiff = (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
    if (severityDiff !== 0) return severityDiff;
    return Number(b.scoreDelta || 0) - Number(a.scoreDelta || 0);
  })[0];

  return {
    threatScore: score,
    severity: getSeverityByScore(score),
    confidence,
    attackType: strongestEvidence?.attackType || 'SUSPICIOUS_REQUEST',
    matchedRule: strongestEvidence?.ruleName || '',
    matchedPayload: strongestEvidence?.matchedValuePreview || '',
  };
};
