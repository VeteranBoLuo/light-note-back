export const SECURITY_CONFIG = {
  maxPreviewLength: 240,
  maxPayloadLength: 12000,
  highFrequencyPerMinute: Number(process.env.SECURITY_HIGH_FREQUENCY_PER_MINUTE || 120),
  pathEnumerationPerMinute: Number(process.env.SECURITY_PATH_ENUMERATION_PER_MINUTE || 40),
  scanner404FiveMinutes: Number(process.env.SECURITY_404_FIVE_MINUTES || 20),
  loginFailFiveMinutes: Number(process.env.SECURITY_LOGIN_FAIL_FIVE_MINUTES || 8),
  blockEnabled: process.env.SECURITY_BLOCK_ENABLED !== 'false',
};

export const SENSITIVE_KEYS = [
  /password/i,
  /^pwd$/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /^sid$/i,
  /secret/i,
  /credential/i,
];

export const SAFE_PREFIXES = ['/security'];

export const SENSITIVE_PATHS = [
  { pattern: /^\/?\.env/i, score: 45, name: '探测 .env 配置文件' },
  { pattern: /^\/?\.git(?:\/|$)/i, score: 45, name: '探测 Git 目录' },
  { pattern: /^\/?\.svn(?:\/|$)/i, score: 35, name: '探测 SVN 目录' },
  { pattern: /^\/?\.ds_store$/i, score: 25, name: '探测系统隐藏文件' },
  { pattern: /(?:^|\/)(wp-admin|wp-login\.php|xmlrpc\.php)(?:\/|$)/i, score: 35, name: '探测 WordPress 入口' },
  { pattern: /(?:^|\/)(phpmyadmin|pma|adminer)(?:\/|$)/i, score: 40, name: '探测数据库管理入口' },
  { pattern: /(?:^|\/)(backup|dump|db|database).*\.(zip|tar|gz|sql|bak)$/i, score: 45, name: '探测备份文件' },
  { pattern: /(?:^|\/)(server-status|actuator|swagger-ui|api-docs)(?:\/|$)/i, score: 30, name: '探测管理或文档端点' },
];

export const MALICIOUS_FILE_EXTENSIONS = /\.(php\d?|phtml|jsp|jspx|asp|aspx|ashx|sh|bash|cmd|bat|exe|dll|so)$/i;

export const SIGNATURE_RULES = [
  {
    code: 'SQL_BOOLEAN_COMMENT',
    name: 'SQL 布尔盲注或注释截断',
    attackType: 'SQL_INJECTION',
    severity: 'high',
    baseScore: 55,
    confidence: 88,
    regex: /(?:'|%27|")\s*(?:or|and)\s+(?:'?\d+'?\s*=\s*'?\d+'?|[a-z_][\w]*\s*=\s*[a-z_][\w]*)(?:\s*(?:--|#|\/\*))?/i,
    includedContexts: ['numeric', 'identifier'],
  },
  {
    code: 'SQL_UNION_SELECT',
    name: 'SQL UNION SELECT 注入',
    attackType: 'SQL_INJECTION',
    severity: 'critical',
    baseScore: 70,
    confidence: 92,
    regex: /\bunion(?:\s+all)?\s+select\b/i,
    includedContexts: ['numeric', 'identifier'],
  },
  {
    code: 'SQL_STACKED_QUERY',
    name: 'SQL 堆叠查询',
    attackType: 'SQL_INJECTION',
    severity: 'critical',
    baseScore: 75,
    confidence: 90,
    regex: /;\s*(?:drop|delete|insert|update|alter|truncate|create)\b/i,
    includedContexts: ['numeric', 'identifier'],
  },
  {
    code: 'XSS_SCRIPT',
    name: 'XSS 脚本注入',
    attackType: 'XSS',
    severity: 'high',
    baseScore: 58,
    confidence: 86,
    regex: /<\s*script\b|javascript\s*:|on[a-z]+\s*=|data\s*:\s*text\/html|<\s*iframe\b/i,
    excludedContexts: ['freeText'],
  },
  {
    code: 'COMMAND_INJECTION',
    name: '命令注入特征',
    attackType: 'COMMAND_INJECTION',
    severity: 'critical',
    baseScore: 78,
    confidence: 90,
    regex: /(?:;|\|\||&&|\$\(|`)\s*(?:rm|cat|curl|wget|bash|sh|nc|python|perl)\b|\b(?:rm\s+-rf|wget\s+https?:|curl\s+https?:|spawn\(|exec\()\b/i,
    includedContexts: ['numeric', 'identifier', 'filename', 'unknown'],
  },
  {
    code: 'PATH_TRAVERSAL',
    name: '路径穿越',
    attackType: 'PATH_TRAVERSAL',
    severity: 'high',
    baseScore: 58,
    confidence: 88,
    regex: /(?:\.\.\/|\.\.\\|%2e%2e%2f|%252e%252e%252f|\/etc\/passwd|boot\.ini)/i,
    includedContexts: ['filename', 'unknown'],
  },
  {
    code: 'SSRF_PRIVATE_HOST',
    name: 'SSRF 内网地址访问',
    attackType: 'SSRF',
    severity: 'critical',
    baseScore: 72,
    confidence: 88,
    regex: /https?:\/\/(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/i,
    includedContexts: ['url'],
    fieldPattern: /(callback|redirect|webhook|endpoint|target|fetch|proxy).*url$/i,
  },
  {
    code: 'CRLF_INJECTION',
    name: 'CRLF 注入',
    attackType: 'CRLF_INJECTION',
    severity: 'medium',
    baseScore: 35,
    confidence: 78,
    regex: /(?:\r|\n|%0d|%0a)/i,
    excludedContexts: ['freeText'],
  },
];
