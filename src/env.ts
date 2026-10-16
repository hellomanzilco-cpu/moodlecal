/** Environment lookup accepts the user's existing key names on every platform. */
export function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for(const name of names) {
    const key=Object.keys(env).find(key=>key.toLowerCase()===name.toLowerCase());
    const value=key ? env[key] : undefined;
    if(value?.trim()) return value;
  }
  return undefined;
}
