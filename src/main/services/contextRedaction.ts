/**
 * contextRedaction — central secret redaction for any context that leaves the PTY stream
 * (mesh dispatch context, CLI context, persisted search indexes). One implementation,
 * shared everywhere, so a secret can never leak through a path that "forgot" to redact.
 *
 * Redacts: bearer tokens, API keys, passwords, secrets, private keys (PEM blocks),
 * URLs with embedded credentials, cookies, Authorization headers, and KEY=value lines
 * whose key name is sensitive. Returns { text, redactionCount }.
 */

// eslint-disable-next-line no-control-regex
const PEM_BLOCK_RE = /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi
const API_KEY_RE =
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|token|password|passwd|pwd|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?/gi
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const PRIVATE_KEY_LINE_RE = /^\s*[-]{5}BEGIN [A-Z ]+ PRIVATE KEY[-]{5}.*$/gm
const CRED_URL_RE = /\b(?:https?|ftp):\/\/[^\s/@]+@[^\s/]+/gi
const COOKIE_RE = /\b(?:cookie|cookies)\b\s*[:=]\s*["']?[^"'\s;]{6,}["']?/gi
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
const SENSITIVE_ASSIGN_RE =
  /^\s*(?:export\s+)?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Z_]*\s*=\s*\S+/gim

const REDACTED = '[REDACTED]'

/**
 * Redact secrets from terminal/context text. Returns the cleaned text plus how many
 * replacements were made (drives the "redacted" indicator in the UI + CLI responses).
 */
export function redactContext(text: string): { text: string; redactionCount: number } {
  if (!text) return { text, redactionCount: 0 }
  let count = 0
  const replace = (re: RegExp, input: string): string => {
    re.lastIndex = 0
    return input.replace(re, () => {
      count++
      return REDACTED
    })
  }

  let out = text
  out = replace(PEM_BLOCK_RE, out)
  out = replace(PRIVATE_KEY_LINE_RE, out)
  out = replace(BEARER_RE, out)
  out = replace(GITHUB_TOKEN_RE, out)
  out = replace(SLACK_TOKEN_RE, out)
  out = replace(AWS_KEY_RE, out)
  out = replace(CRED_URL_RE, out)
  out = replace(COOKIE_RE, out)
  out = replace(SENSITIVE_ASSIGN_RE, out)
  out = replace(API_KEY_RE, out)
  return { text: out, redactionCount: count }
}
