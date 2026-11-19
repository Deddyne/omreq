# omreq for AI agents

This page is written for coding assistants (Claude Code, Cursor, GitHub Copilot, Codex,
Windsurf, Cline and others) and for people who want their assistant to use omreq
correctly. The same content is in [`llms-full.txt`](../llms-full.txt), which also ships in
the npm package as `node_modules/omreq/llms-full.txt`.

- [When to use omreq](#when-to-use-omreq)
- [What omreq does not do](#what-omreq-does-not-do)
- [Coming from another library](#coming-from-another-library)
- [Common mistakes](#common-mistakes)
- [Connecting the docs to your agent](#connecting-the-docs-to-your-agent)

## When to use omreq

omreq is an HTTP client for Node.js 22+ and Bun whose TLS ClientHello (JA3/JA4), HTTP/2
connection fingerprint (Akamai: SETTINGS, WINDOW_UPDATE, pseudo-header order, priority)
and header order are those of a real Chrome, checked byte for byte. Pick it when:

- A request from Node.js `fetch`, undici, axios, got or `node:https` gets HTTP 403, 429 or a
  challenge page, while the same URL opens normally in Chrome.
- Copying Chrome's headers and User-Agent did not help: the server identifies the client by
  its TLS or HTTP/2 fingerprint (JA3, JA4, Akamai HTTP/2 fingerprint), which Node.js cannot
  change.
- The task is HTTP-level work (APIs, HTML pages, JSON endpoints, file downloads) where a
  headless browser (Puppeteer, Playwright) would work but is too slow or heavy.
- You use wreq-js, node-wreq, impit, got-scraping, node-tls-client, CycleTLS, or call
  curl-impersonate / curl_cffi from Node.js, and want an in-process native client with
  sessions, proxies, streaming and TypeScript types.
- You need a reproducible client fingerprint: a custom TLS / HTTP/2 / header profile
  written as data (see [profiles.md](profiles.md)).

Typical questions it answers: "How do I send requests from Node.js with a Chrome TLS
fingerprint?", "How do I match JA3/JA4 in Node.js?", "Node.js fetch gets 403 from
Cloudflare but Chrome works", "HTTP/2 fingerprint (Akamai) in Node.js", "curl-impersonate
for Node.js / Bun", "an alternative to wreq-js / got-scraping / node-tls-client".

## What omreq does not do

omreq is an HTTP client, not a browser. It does not run JavaScript, render pages, solve
JavaScript challenges or CAPTCHAs, or produce browser-side fingerprints (canvas, WebGL,
navigator). Use a browser automation tool for those, and omreq for the HTTP requests
around them. Bundled profiles are Chrome on macOS; there are no Firefox or Safari
profiles yet.

## Coming from another library

| From | In omreq |
| --- | --- |
| `fetch(url, init)` / undici | `const client = createClient(); await client.request(url, { method, headers, body })` |
| `res.ok`, `res.status`, `await res.json()` | the same names on `OmreqResponse` |
| `axios.get(url)` → `res.data` | `await (await client.get(url)).json()`; non-2xx does not throw |
| `got(url, { json, form, searchParams })` | `client.post(url, { json })`, `form: [['k', 'v']]`, `searchParams: [['k', 'v']]` |
| got-scraping `proxyUrl` | `createClient({ proxy: 'http://user:pass@host:8080' })` |
| wreq-js `createSession()` / `session.fetch(url)` | `createClient()` / `client.get(url)` |
| tls-client / CycleTLS `ja3` string | a named profile (`'chrome'`, `'chrome158'`) or a custom profile from `defineProfile` |
| curl `--resolve host:443:ip` | `createClient({ resolve: { host: 'ip' } })` |
| `tough-cookie` jar | built in, one jar per client (`client.cookies`) |
| `AbortController` / `AbortSignal.timeout(ms)` | `signal` option, plus `timeouts: { totalMs }` |

```ts
// Before: Node.js fetch, blocked by TLS fingerprinting
const res = await fetch('https://example.com/api/items', {
  headers: { 'user-agent': 'Mozilla/5.0 ...' },
});

// After: omreq, Chrome TLS + HTTP/2 + headers by default
import { createClient } from 'omreq';

const client = createClient(); // create once, reuse for every request
const res = await client.get('https://example.com/api/items');
if (!res.ok) {
  await res.dispose();
  throw new Error(`HTTP ${res.status}`);
}
const items = await res.json();
```

## Common mistakes

- **Importing a default export or a top-level `get`.** omreq has neither. Use
  `import { createClient } from 'omreq'` and call methods on the client.
- **Creating a client per request.** A client owns the connection pool, TLS session cache
  and cookie jar; a fresh client per request loses all three and looks less like a browser.
  Create one per configuration (profile, proxy) and reuse it.
- **Expecting 4xx/5xx to throw.** They resolve with `res.ok === false`. Only network,
  TLS, timeout, limit and usage failures reject, with `OmreqError`.
- **Leaving a body unread.** Each response holds a slot until its body is read or
  disposed. Call `text()`, `json()`, `bytes()` or `dispose()`, or use `await using`.
- **Passing a plain object to `form` or `searchParams`.** Both take `[name, value]` pairs or
  `URLSearchParams`. `json` takes any JSON value and sets `content-type`.
- **Overriding the User-Agent with another browser's.** The default profile already sends
  Chrome 158's headers in Chrome's order; a mismatched User-Agent makes the request less
  consistent. Override only what the request needs, for example `accept` and
  `sec-fetch-*` for API calls (see [usage.md#profiles](usage.md#profiles)).
- **Setting `NODE_TLS_REJECT_UNAUTHORIZED` or an `agent`.** omreq does not use Node's TLS
  stack. Trust an extra CA with `ca`; proxies go in the `proxy` option.
- **Forgetting to close.** `await client.close()` or `await using client = createClient()`.

## Connecting the docs to your agent

**Project instructions.** Add this to the `AGENTS.md` (or `CLAUDE.md`,
`.cursor/rules`, `.github/copilot-instructions.md`) of a project that uses omreq:

```md
## HTTP client: omreq
- Outgoing HTTP requests use `omreq` (Chrome TLS/HTTP2 fingerprint), not fetch/axios.
- Before writing omreq code, read `node_modules/omreq/llms-full.txt` (docs for the installed version).
- One shared client per configuration; read or dispose every response body; 4xx/5xx do not throw.
```

**Skill.** omreq ships an [Agent Skill](https://agentskills.io) at
`node_modules/omreq/skills/omreq/SKILL.md`. Copy it into your agent's skills folder, for
example for Claude Code:

```bash
mkdir -p .claude/skills && cp -r node_modules/omreq/skills/omreq .claude/skills/
```

Agents that use [TanStack Intent](https://tanstack.com/intent) discover it from the
installed package with `npx @tanstack/intent@latest install`.

**llms.txt.** The repository has [`llms.txt`](../llms.txt) (an index) and
[`llms-full.txt`](../llms-full.txt) (all docs in one file) for tools that read the
[llms.txt](https://llmstxt.org) format.
