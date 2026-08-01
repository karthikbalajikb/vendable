/** GET a URL and return its status code (0 on network error). Redirects count as reachable. */
export async function probe(url: string, timeoutMs = 8000): Promise<number> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch {
    return 0;
  }
}

/** True when a URL responds with a 2xx/3xx status. */
export async function reachable(url: string, timeoutMs = 8000): Promise<boolean> {
  const code = await probe(url, timeoutMs);
  return code >= 200 && code < 400;
}
