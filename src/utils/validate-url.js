export function validateHttpsUrl(url, label = 'URL') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${label} URL: "${url}"`);
  }
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (!isLocalhost && parsed.protocol !== 'https:') {
    throw new Error(`${label} URL must use HTTPS for non-localhost hosts, got: ${url}`);
  }
}
