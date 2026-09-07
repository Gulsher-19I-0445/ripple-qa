// Minimal globalThis.fetch stub. Routes by URL substring and records every call,
// so tests can assert not just on results but on which hosts were contacted —
// which is how the "zero GitHub calls" and repo-allowlist tests are enforced.

export function installFetchStub(routes) {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init, host: new URL(href).host });

    for (const route of routes) {
      if (href.includes(route.match)) {
        if (route.throw) throw route.throw;
        return makeResponse(route);
      }
    }

    throw new Error(`fetch-stub: no route matched ${href}`);
  };

  return {
    calls,
    callsToHost: host => calls.filter(c => c.host === host),
    githubCalls: () => calls.filter(c => c.host.includes('github')),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeResponse({ status = 200, body = {}, headers = {} }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: name => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

export const baseConfig = {
  jira: { url: 'https://acme.atlassian.net', email: 'qa@acme.test', projectKey: 'KAN' },
  confluence: { url: 'https://acme.atlassian.net', spaceKey: 'SD' },
  github: { owner: 'acme', repo: 'storefront' },
};

export const ticket = { key: 'KAN-4', id: '10042', summary: 'Cart total rounding' };

export function prFilesPayload(count, patchSize = 20) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/cart/file${i}.js`,
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: 'x'.repeat(patchSize),
  }));
}
