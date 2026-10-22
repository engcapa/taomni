export type QaCompletionEvent = Record<string, unknown>;

export const qaCompletionEvents: QaCompletionEvent[] = [];

export function recordQaCompletion(event: QaCompletionEvent): void {
  if (!__TAOMNI_QA_COMPLETION_OBSERVATION__) return;
  qaCompletionEvents.push(event);
  if (qaCompletionEvents.length > 80) qaCompletionEvents.shift();
}

if (__TAOMNI_QA_COMPLETION_OBSERVATION__ && typeof window !== "undefined") {
  (window as Window & {
    __taomniQaCompletionObservation?: { observe: () => { events: QaCompletionEvent[]; }; };
  }).__taomniQaCompletionObservation = {
    observe: () => ({ events: JSON.parse(JSON.stringify(qaCompletionEvents)) as QaCompletionEvent[] }),
  };
}
