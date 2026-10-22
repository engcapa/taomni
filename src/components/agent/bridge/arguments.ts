


export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}



export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item) => item.length > 0);
  }
  const single = asString(value);
  return single ? [single] : [];
}
