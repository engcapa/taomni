type ReadOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Let a quick local read publish ready content without a loading/unmount cycle. */
export async function readAheadForDisplay<T>(read: Promise<T>, delayMs = 80) {
  const pending: Promise<ReadOutcome<T>> = read.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      pending,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), delayMs); }),
    ]);
    return { ready, pending };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
