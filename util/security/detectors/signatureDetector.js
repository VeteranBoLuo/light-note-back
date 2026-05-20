import { getFieldContext } from '../fieldContext.js';
import { MALICIOUS_FILE_EXTENSIONS, SENSITIVE_PATHS, SIGNATURE_RULES } from '../rules.js';
import { flattenObject, safeJsonStringify, truncateText } from '../payloadSanitizer.js';

const createEvidence = ({ rule, field, value, message, scoreDelta, confidence }) => ({
  ruleCode: rule.code,
  ruleName: rule.name,
  detector: 'signature',
  attackType: rule.attackType,
  severity: rule.severity,
  matchedField: field,
  matchedValuePreview: truncateText(value),
  evidenceMessage: message || `${rule.name} 命中字段 ${field}`,
  scoreDelta: scoreDelta ?? rule.baseScore,
  confidence: confidence ?? rule.confidence,
});

const isRuleApplicable = (rule, context) => {
  if (rule.includedContexts && !rule.includedContexts.includes(context)) {
    return false;
  }
  if (rule.excludedContexts && rule.excludedContexts.includes(context)) {
    return false;
  }
  return true;
};

const isRuleApplicableToField = (rule, field) => {
  if (!rule.fieldPattern) {
    return true;
  }
  return rule.fieldPattern.test(String(field).split('.').pop() || field);
};

const detectPayloadSignatures = (context) => {
  const fields = [
    ...flattenObject(context.query, 'query'),
    ...flattenObject(context.body, 'body'),
    ...flattenObject(context.params, 'params'),
  ];
  const evidence = [];
  for (const item of fields) {
    const fieldContext = getFieldContext(item.field);
    for (const rule of SIGNATURE_RULES) {
      if (!isRuleApplicable(rule, fieldContext)) {
        continue;
      }
      if (!isRuleApplicableToField(rule, item.field)) {
        continue;
      }
      if (rule.regex.test(String(item.value))) {
        evidence.push(
          createEvidence({
            rule,
            field: item.field,
            value: item.value,
            message: `${rule.name}，字段类型：${fieldContext}`,
          }),
        );
      }
    }
  }
  return evidence;
};

const detectHeaderInjection = (context) => {
  const headerText = safeJsonStringify(context.headersSummary);
  if (!/%0d|%0a|\r|\n/i.test(headerText)) {
    return [];
  }
  const rule = {
    code: 'HEADER_CRLF_INJECTION',
    name: '请求头 CRLF 注入',
    attackType: 'CRLF_INJECTION',
    severity: 'medium',
    baseScore: 35,
    confidence: 80,
  };
  return [
    createEvidence({
      rule,
      field: 'headers',
      value: headerText,
      message: '请求头中出现 CRLF 注入特征',
    }),
  ];
};

const detectSensitivePath = (context) => {
  const normalizedPath = String(context.path || '').replace(/^\/api\//, '/');
  const matched = SENSITIVE_PATHS.find((item) => item.pattern.test(normalizedPath.replace(/^\//, '')));
  if (!matched) {
    return [];
  }
  const rule = {
    code: 'SENSITIVE_PATH_PROBE',
    name: matched.name,
    attackType: 'SCANNER',
    severity: matched.score >= 50 ? 'high' : 'medium',
    baseScore: matched.score,
    confidence: 86,
  };
  return [
    createEvidence({
      rule,
      field: 'path',
      value: context.path,
      message: `访问常见敏感路径：${context.path}`,
    }),
  ];
};

const detectFileUpload = (context) => {
  const evidence = [];
  for (const file of context.files || []) {
    const filename = file.originalname || file.filename || '';
    if (!MALICIOUS_FILE_EXTENSIONS.test(filename)) {
      continue;
    }
    const rule = {
      code: 'MALICIOUS_FILE_UPLOAD',
      name: '恶意文件上传',
      attackType: 'MALICIOUS_FILE_UPLOAD',
      severity: 'critical',
      baseScore: 86,
      confidence: 88,
    };
    evidence.push(
      createEvidence({
        rule,
        field: 'files.originalname',
        value: filename,
        message: `上传了高风险扩展名文件：${filename}`,
      }),
    );
  }
  return evidence;
};

const detectParameterAnomaly = (context) => {
  const fields = [...flattenObject(context.query, 'query'), ...flattenObject(context.body, 'body')];
  const evidence = [];
  for (const item of fields) {
    const fieldContext = getFieldContext(item.field);
    if (fieldContext !== 'numeric') {
      continue;
    }
    const value = String(item.value);
    if (value && !/^-?\d+(\.\d+)?$/.test(value)) {
      const rule = {
        code: 'NUMERIC_PARAM_ANOMALY',
        name: '数值参数异常',
        attackType: 'PAYLOAD_ANOMALY',
        severity: 'low',
        baseScore: 12,
        confidence: 68,
      };
      evidence.push(
        createEvidence({
          rule,
          field: item.field,
          value,
          message: `数值型字段出现非数值内容：${item.field}`,
        }),
      );
    }
  }
  return evidence;
};

export const detectSignatures = (context) => [
  ...detectSensitivePath(context),
  ...detectPayloadSignatures(context),
  ...detectHeaderInjection(context),
  ...detectFileUpload(context),
  ...detectParameterAnomaly(context),
];
