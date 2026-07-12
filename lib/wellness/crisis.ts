// High-risk phrases that may indicate a student is in immediate danger.
// Detection is intentionally broad — false positives are far less harmful
// than a missed genuine crisis. Teachers are trained to assess context.
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

export function hasCrisisKeywords(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CRISIS_PHRASES.some((phrase) => lower.includes(phrase));
}
