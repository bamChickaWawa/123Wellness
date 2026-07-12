// The set of emotions a student can pick when they check in.
// `sentiment` powers the "which students may need support" signal that
// teachers/admins see — negative sentiment is the hook for the alerts feature.
export type Sentiment = 'positive' | 'neutral' | 'negative';

export type Emotion = {
  label: string;
  emoji: string;
  sentiment: Sentiment;
};

export const EMOTIONS: Emotion[] = [
  { label: 'Happy', emoji: '😊', sentiment: 'positive' },
  { label: 'Calm', emoji: '😌', sentiment: 'positive' },
  { label: 'Excited', emoji: '🤩', sentiment: 'positive' },
  { label: 'Okay', emoji: '🙂', sentiment: 'neutral' },
  { label: 'Tired', emoji: '😴', sentiment: 'neutral' },
  { label: 'Bored', emoji: '😐', sentiment: 'neutral' },
  { label: 'Sad', emoji: '😢', sentiment: 'negative' },
  { label: 'Anxious', emoji: '😰', sentiment: 'negative' },
  { label: 'Angry', emoji: '😠', sentiment: 'negative' }
];

export const EMOTION_MAP: Record<string, Emotion> = Object.fromEntries(
  EMOTIONS.map((e) => [e.label, e])
);
