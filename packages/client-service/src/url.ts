export function baseUrl(url: string): string {
  const address = /^https?:\/\//.test(url) ? url :
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(url) ? `http://${url}` : `https://${url}`;
  const parsed = new URL(address);
  if (
    !/^(http:|https:)$/.test(parsed.protocol) || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw new Error("invalid server URL");
  }
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("HTTP is permitted only for loopback; use HTTPS for remote servers");
  }
  return parsed.href.replace(/\/$/, "");
}
