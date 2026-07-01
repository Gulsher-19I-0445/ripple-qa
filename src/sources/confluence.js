import { validateHttpsUrl } from '../utils/validate-url.js';

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function makeAuthHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function confluenceFetch(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: makeAuthHeader(config.jira.email, process.env.CONFLUENCE_API_TOKEN),
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('Confluence authentication failed. Check CONFLUENCE_API_TOKEN.');
    }

    if (!res.ok) {
      throw new Error(`Confluence API error: ${res.status} ${res.statusText}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function searchPages(query, config) {
  const safeQuery = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cql = `space="${config.confluence.spaceKey}" AND text~"${safeQuery}"`;
  const url = `${config.confluence.url}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=5&expand=excerpt`;

  try {
    const data = await confluenceFetch(url, config);
    return (data.results ?? []).map(page => ({
      id: page.id,
      title: page.title,
      excerpt: stripHtml(page.excerpt ?? ''),
      url: `${config.confluence.url}/wiki${page._links?.webui ?? ''}`,
    }));
  } catch (err) {
    if (err.name === 'AbortError') return [];
    throw err;
  }
}

async function fetchPageContent(pageId, config) {
  const url = `${config.confluence.url}/wiki/rest/api/content/${pageId}?expand=body.storage`;
  const data = await confluenceFetch(url, config);
  const html = data.body?.storage?.value ?? '';
  return stripHtml(html).slice(0, 3000);
}

export async function fetchPageById(pageId, pageTitle, pageUrl, config) {
  validateHttpsUrl(config.confluence.url, 'Confluence');
  const content = await fetchPageContent(pageId, config);
  if (!content) return null;
  return { title: pageTitle, content, url: pageUrl };
}

export async function findRelatedPages(ticketContext, config) {
  validateHttpsUrl(config.confluence.url, 'Confluence');
  const { summary, components, labels } = ticketContext;

  const queries = new Set();

  const words = summary.split(/\s+/).filter(w => w.length > 4);
  if (words.length > 0) queries.add(words.slice(0, 5).join(' '));

  for (const c of components ?? []) queries.add(c);
  for (const l of labels ?? []) queries.add(l);

  const seen = new Map();

  for (const query of queries) {
    if (!query.trim()) continue;
    try {
      const results = await searchPages(query, config);
      for (const page of results) {
        if (!seen.has(page.id)) seen.set(page.id, page);
      }
    } catch {
      // continue — confluence errors are non-fatal
    }
  }

  const pages = [...seen.values()].slice(0, 3);

  const withContent = await Promise.all(
    pages.map(async page => {
      const content = await fetchPageContent(page.id, config);
      return { title: page.title, content, url: page.url };
    })
  );

  return withContent.filter(p => p.content.length > 0);
}
