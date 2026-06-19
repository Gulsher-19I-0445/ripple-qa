function adfToText(node) {
  if (!node) return '';

  if (node.type === 'text') return node.text ?? '';

  const blockTypes = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'rule']);
  const listTypes = new Set(['bulletList', 'orderedList']);

  let text = '';

  if (node.content) {
    for (const child of node.content) {
      const childText = adfToText(child);
      if (listTypes.has(node.type)) {
        text += childText;
      } else {
        text += childText;
      }
    }
  }

  if (node.type === 'listItem') return `- ${text.trim()}\n`;
  if (blockTypes.has(node.type)) return text.trim() + '\n\n';
  if (node.type === 'hardBreak') return '\n';

  return text;
}

function makeAuthHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function jiraFetch(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: makeAuthHeader(config.jira.email, process.env.JIRA_API_TOKEN),
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('Jira authentication failed. Check JIRA_API_TOKEN and email in config.');
    }

    if (!res.ok) {
      throw new Error(`Jira API error: ${res.status} ${res.statusText}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchTicket(ticketKey, config) {
  const url = `${config.jira.url}/rest/api/3/issue/${encodeURIComponent(ticketKey)}`;
  let data;

  try {
    data = await jiraFetch(url, config);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Jira request timed out for ${ticketKey}.`);
    if (err.message.includes('404') || err.message.includes('does not exist')) {
      throw new Error(`Ticket ${ticketKey} not found. Check the key and your project config.`);
    }
    throw err;
  }

  const fields = data.fields ?? {};

  const description = fields.description ? adfToText(fields.description).trim() : '';

  const acceptanceCriteria =
    fields.customfield_10016
      ? (typeof fields.customfield_10016 === 'object'
          ? adfToText(fields.customfield_10016).trim()
          : String(fields.customfield_10016))
      : '';

  return {
    key: data.key,
    summary: fields.summary ?? '',
    description,
    acceptanceCriteria,
    issuetype: fields.issuetype?.name ?? 'Unknown',
    priority: fields.priority?.name ?? 'Unknown',
    components: (fields.components ?? []).map(c => c.name),
    labels: fields.labels ?? [],
    fixVersions: (fields.fixVersions ?? []).map(v => v.name),
    status: fields.status?.name ?? 'Unknown',
  };
}

export async function fetchRemoteLinks(ticketKey, config) {
  const url = `${config.jira.url}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/remotelink`;
  let data;

  try {
    data = await jiraFetch(url, config);
  } catch (err) {
    if (err.name === 'AbortError') return [];
    return [];
  }

  const confluenceBase = config.confluence?.url ?? '';
  const links = [];

  for (const link of data ?? []) {
    const obj = link.object ?? {};
    const href = obj.url ?? '';
    const title = obj.title ?? '';
    if (confluenceBase && href.startsWith(confluenceBase) && href.includes('/pages/')) {
      links.push({ title, url: href });
    }
  }

  return links;
}

export async function fetchReleaseTickets(versionName, config) {
  const safeVersion = versionName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const jql = `project="${config.jira.projectKey}" AND fixVersion="${safeVersion}"`;
  const baseUrl = `${config.jira.url}/rest/api/3/search`;
  const keys = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `${baseUrl}?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&startAt=${startAt}&fields=summary`;
    let data;

    try {
      data = await jiraFetch(url, config);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Jira request timed out fetching release tickets.');
      throw err;
    }

    for (const issue of data.issues ?? []) {
      keys.push(issue.key);
    }

    if (keys.length >= data.total || (data.issues ?? []).length === 0) break;
    startAt += maxResults;
  }

  return keys;
}
