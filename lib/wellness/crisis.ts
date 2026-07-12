// ── Tier 1: Explicit crisis language ─────────────────────────────────────────
// Phrases that may indicate imminent danger. Detection is intentionally broad
// — false positives are far less harmful than a missed genuine crisis.
// Teachers are trained to assess context.
const CRISIS_PHRASES = [
  'suicide',
  'suicidal',
  'kill myself',
  'killing myself',
  'kill me',
  'want to die',
  'wanna die',
  'wanted to die',
  'end my life',
  'end it all',
  'hurt myself',
  'hurting myself',
  'harm myself',
  'self harm',
  'self-harm',
  'cut myself',
  'no reason to live',
  "don't want to live",
  "dont want to live",
  "can't go on",
  "cant go on",
  'not worth living',
  'better off dead',
  'better off without me'
];

// ── Tier 2: Ambiguous distress language ──────────────────────────────────────
// Softer phrases that may signal a student is struggling but stop short of
// explicit crisis language. These warrant a teacher check-in, not emergency
// protocol. Expect more false positives ("I give up on this homework") — the
// goal is to surface patterns teachers can evaluate with context.
const CONCERN_PHRASES = [
  'hate myself',
  'hate my life',
  'feel invisible',
  'feel like nobody cares',
  'nobody cares',
  'no one cares',
  "what's the point",
  'whats the point',
  'feel worthless',
  'feel like a burden',
  "i'm a burden",
  'im a burden',
  'tired of everything',
  'tired of it all',
  'tired of life',
  "don't care anymore",
  'dont care anymore',
  'feel hopeless',
  'feel empty',
  'feel numb',
  'nothing matters',
  'everything is pointless',
  'feel like giving up',
  'feel so alone',
  'feel completely alone',
  'feel like no one understands',
  'no one understands',
  'i give up',
  'so done with everything',
  'i hate everything'
];

export function hasCrisisKeywords(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CRISIS_PHRASES.some((phrase) => lower.includes(phrase));
}

export function hasConcernKeywords(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CONCERN_PHRASES.some((phrase) => lower.includes(phrase));
}
