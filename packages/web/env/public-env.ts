export function publicViteEnv(
  ...envSets: readonly Record<string, string>[]
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const env of envSets) {
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith('VITE_')) merged[key] = value;
    }
  }
  return merged;
}
