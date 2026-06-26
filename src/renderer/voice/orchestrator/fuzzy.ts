/**
 * Tiny, dependency-free fuzzy matcher — the cheap, FREE, fully-local way to make Odla robust to
 * speech-to-text noise. A multilingual model transcribing a Spanish speaker saying English product
 * names ("Claude") often returns near-misses ("clode", "cloud", "claud"); exact matching then fails
 * or, worse, collides with another word. We keep explicit variant lists for high precision AND fall
 * back to a Levenshtein ratio so single-character slips still resolve to the right command.
 */

/** Levenshtein edit distance (iterative, single-row). */
export function lev(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[n]
}

/** Similarity in 0..1 (1 = identical). */
export function ratio(a: string, b: string): number {
  const L = Math.max(a.length, b.length)
  return L === 0 ? 1 : 1 - lev(a, b) / L
}

/**
 * Best similarity of `phrase` against `norm`: exact whole-token containment scores 1, otherwise the
 * closest sliding window of the same word-count is scored by Levenshtein ratio. Short phrases (≤4
 * chars) demand a tighter ratio so noise can't trigger them.
 */
export function fuzzyScore(norm: string, phrase: string): number {
  if (` ${norm} `.includes(` ${phrase} `)) return 1
  const words = phrase.split(' ')
  const toks = norm.split(' ').filter(Boolean)
  const k = words.length
  let best = 0
  for (let i = 0; i + k <= toks.length; i++) {
    best = Math.max(best, ratio(toks.slice(i, i + k).join(' '), phrase))
  }
  // Also test the whole utterance against the phrase (handles run-together transcripts).
  best = Math.max(best, ratio(norm, phrase))
  return best
}

/**
 * Length-aware match threshold — the precision/recall knob for the WHOLE local grammar (every command
 * flows through here via fuzzyHas/bestFuzzy). Short tokens demand a tight ratio (noise can't trigger
 * them); longer phrases are looser so ASR slips (accent, dropped/extra letters, mild language
 * confusion) still land. Named so tuning happens in one obvious place.
 */
const SHORT_LEN = 4
const MID_LEN = 6
const SHORT_THRESHOLD = 0.84
const MID_THRESHOLD = 0.76
const LONG_THRESHOLD = 0.72
export function matchThreshold(phrase: string): number {
  const len = phrase.replace(/\s/g, '').length
  if (len <= SHORT_LEN) return SHORT_THRESHOLD
  if (len <= MID_LEN) return MID_THRESHOLD
  return LONG_THRESHOLD
}

/** True when `phrase` matches `norm` at/above a length-aware threshold. */
export function fuzzyHas(norm: string, phrase: string): boolean {
  return fuzzyScore(norm, phrase) >= matchThreshold(phrase)
}

/** Pick the entry whose any phrase best matches `norm` (exact wins; else best fuzzy ≥ threshold). */
export function bestFuzzy<T>(norm: string, entries: ReadonlyArray<readonly [T, readonly string[]]>): { key: T; score: number } | null {
  let best: { key: T; score: number } | null = null
  for (const [key, phrases] of entries) {
    for (const p of phrases) {
      const score = fuzzyScore(norm, p)
      if (score >= matchThreshold(p) && (!best || score > best.score)) best = { key, score }
    }
  }
  return best
}
