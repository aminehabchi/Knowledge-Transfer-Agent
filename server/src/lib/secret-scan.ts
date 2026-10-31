/**
 * Detects values that look like credentials so they are never persisted in handover content.
 * Deliberately conservative: false positives are reported to the author, who can rephrase
 * (e.g. reference the Key Vault secret name instead of its value).
 */
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "anthropic_or_openai_key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "azure_storage_key", re: /AccountKey=[A-Za-z0-9+/=]{40,}/i },
  { kind: "connection_string_password", re: /\b(?:password|pwd)\s*=\s*[^;\s]{4,}/i },
  { kind: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i },
  { kind: "password_assignment", re: /\b(?:password|passwd|passcode|secret|api[_-]?key|client[_-]?secret|token)\s*[:=]\s*["']?[^\s"']{6,}/i },
];

export interface SecretFinding {
  path: string;
  kind: string;
}

export function scanForSecrets(value: unknown, path = ""): SecretFinding[] {
  if (typeof value === "string") {
    const hit = PATTERNS.find((p) => p.re.test(value));
    return hit ? [{ path: path || "(root)", kind: hit.kind }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => scanForSecrets(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => scanForSecrets(v, path ? `${path}.${k}` : k));
  }
  return [];
}
