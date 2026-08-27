#!/usr/bin/env bun
// health-check.ts
// Verifies connectivity to GitLab and Zendesk APIs using current environment variables

const required = [
  'ZENDESK_DOMAIN', 'ZENDESK_OAUTH_CLIENT_ID', 'ZENDESK_OAUTH_CLIENT_SECRET',
  'GITLAB_DOMAIN', 'GITLAB_TOKEN',
  'GITLAB_WORK_ITEM_FIELD_ID', 'GITLAB_TYPE_FIELD_ID', 'GITLAB_STATUS_FIELD_ID'
];
const missing = required.filter((v) => !Bun.env[v]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('See the Configuration section of README.md for what each one is.');
  process.exit(1);
}

const zendeskDomain = Bun.env.ZENDESK_DOMAIN;
const gitlabDomain = Bun.env.GITLAB_DOMAIN;
const gitlabToken = Bun.env.GITLAB_TOKEN;
const workItemFieldId = Bun.env.GITLAB_WORK_ITEM_FIELD_ID;

let zendeskAuth = '';

async function mintZendeskToken() {
  const res = await fetch(`${zendeskDomain}/oauth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: `${Bun.env.ZENDESK_OAUTH_CLIENT_ID}`,
      client_secret: `${Bun.env.ZENDESK_OAUTH_CLIENT_SECRET}`,
      scope: 'tickets:read tickets:write read write',
    }),
  });
  if (!(res as any).ok) {
    console.error(`Zendesk token: ❌ could not mint (status ${(res as any).status})`);
    console.error('  Check ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET.');
    return false;
  }
  const data = await (res as any).json();
  zendeskAuth = `Bearer ${data.access_token}`;
  console.log(`Zendesk token: ✅ minted, valid for ${data.expires_in}s`);
  return true;
}

async function zendeskGet(path: string) {
  return await fetch(`${zendeskDomain}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': zendeskAuth
    }
  });
}

async function checkZendesk() {
  if (!(await mintZendeskToken())) return;

  try {
    const res = await zendeskGet('/api/v2/tickets.json?page[size]=1');
    if ((res as any).ok) {
      console.log('Zendesk API: ✅ reachable');
    } else {
      console.error(`Zendesk API: ❌ unreachable (status ${(res as any).status})`);
      if ((res as any).status === 403) console.error('  Token lacks a required scope.');
      return;
    }
  } catch (e) {
    console.error('Zendesk API: ❌ error', e);
    return;
  }

  // The sync finds its tickets through the search endpoint, which is scoped
  // separately from plain ticket reads. Check what the app actually uses.
  try {
    const query = encodeURIComponent(`type:ticket status<closed custom_field_${workItemFieldId}:*`);
    const res = await zendeskGet(`/api/v2/search?query=${query}`);
    if ((res as any).ok) {
      const data = await (res as any).json();
      const count = data.count ?? data.results?.length ?? 0;
      console.log(`Zendesk search: ✅ works (${count} open ticket(s) with a GitLab Work Item set)`);
    } else {
      console.error(`Zendesk search: ❌ failed (status ${(res as any).status})`);
      console.error('  The sync cannot find tickets without this.');
    }
  } catch (e) {
    console.error('Zendesk search: ❌ error', e);
  }
}

async function checkGitLab() {
  try {
    const res = await fetch(`${gitlabDomain}/api/v4/user`, {
      headers: {
        'PRIVATE-TOKEN': `${gitlabToken}`,
        'Accept': 'application/json'
      }
    });
    if ((res as any).ok) {
      console.log('GitLab API: ✅ reachable');
    } else {
      console.error(`GitLab API: ❌ unreachable (status ${(res as any).status})`);
      if ((res as any).status === 401) {
        console.error('  Token rejected. A personal access token starts with "glpat-" and needs the read_api scope.');
      }
    }
  } catch (e) {
    console.error('GitLab API: ❌ error', e);
  }
}

await checkZendesk();
await checkGitLab();
