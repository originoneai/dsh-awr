// Keeps what looks like a credential out of a command line that the plugin shows again (DSH-050).
//
// The model and the user already saw the command when it ran; this only stops the plugin from copying a token into a
// prompt block or a command answer a second time. It is a courtesy for the common shapes, not a guarantee: a secret
// written some other way is not recognised, which is one more reason the plugin shows only a trimmed command.

const NAME = '[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|auth(?:orization)?|credential|private[_-]?key)[A-Za-z0-9_.-]*'

const RULES = [
  // FOO_TOKEN=value, --api-key=value, --password value, -p is too ambiguous to guess at
  [new RegExp(`(\\b${NAME}=)("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1***'],
  [new RegExp(`(--${NAME}(?:=|\\s+))("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1***'],
  // Authorization headers and bearer tokens
  [/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, '$1***'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // user:password@host in a URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1***@'],
  // well-known token shapes
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'],
]

/** @param {string} text */
export function redact(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}
