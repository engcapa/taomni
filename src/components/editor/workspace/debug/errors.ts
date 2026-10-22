

/** Message text from a rejected DAP request, for console surfacing. */
export function errorText(error: unknown): string {
  return error instanceof Error? error.message:String(error);
}
