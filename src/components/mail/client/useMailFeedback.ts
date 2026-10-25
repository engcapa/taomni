import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

interface MailStatus {
  text: string | null;
  operation: boolean;
}

/** Operation results stay visible while cache, body and sync work completes. */
export function useMailFeedback() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MailStatus>({ text: null, operation: false });
  const setStatus = useCallback<Dispatch<SetStateAction<string | null>>>((next) => {
    setNotice((current) => {
      const text = typeof next === "function" ? next(current.text) : next;
      return { text, operation: text !== null };
    });
  }, []);
  const setLoadingStatus = useCallback<Dispatch<SetStateAction<string | null>>>((next) => {
    setNotice((current) => current.operation ? current : {
      text: typeof next === "function" ? next(current.text) : next,
      operation: false,
    });
  }, []);
  return { status: notice.text, setStatus, setLoadingStatus, error, setError };
}
