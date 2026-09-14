import crypto from 'node:crypto';
import http from 'node:http';
import { exec } from 'node:child_process';
import {
  CREDENTIAL_KEYS,
  ENV_PATH,
  KEY_HELP,
  mask,
  parseEnv,
  readEnvFile,
  upsert,
  valueWarnings,
  writeEnvFile,
} from '../lib/envfile.js';

/**
 * `npm run setup` — a paste-friendly form for filling in .env.
 *
 * It is deliberately local-only: the server binds to 127.0.0.1, refuses any
 * request that did not arrive over the loopback interface, and requires a
 * one-time token that only appears in the URL printed on your terminal. Values
 * you paste go straight to the .env file on this machine. Nothing is uploaded,
 * logged, or sent to Claude.
 */

const TOKEN = crypto.randomBytes(24).toString('hex');

function isLoopback(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  // Also pin the Host header, so a hostile page can't point a browser here
  // through a DNS name that resolves to 127.0.0.1.
  const host = (request.headers.host ?? '').split(':')[0];
  const hostOk = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  return local && hostOk;
}

function page(values: Map<string, string>, port: number): string {
  const rows = CREDENTIAL_KEYS.map((key) => {
    const help = KEY_HELP[key];
    const existing = values.get(key) ?? '';
    return `
      <label class="row${help?.required ? ' required' : ''}">
        <div class="meta">
          <span class="name">${key}</span>
          ${help?.required ? '<span class="tag req">required</span>' : '<span class="tag opt">optional</span>'}
          <span class="desc">${help?.label ?? ''}</span>
          <span class="where">${help?.where ?? ''}</span>
        </div>
        <div class="field">
          <input type="password" name="${key}" autocomplete="off" spellcheck="false"
                 placeholder="${existing ? `currently ${mask(existing)} — leave blank to keep` : 'paste here'}" />
          <button type="button" class="peek" aria-label="Show or hide">show</button>
        </div>
      </label>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Creator Partnership OS — keys</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --card:#fff; --ink:#1c1c1a; --muted:#6b6b66;
          --line:#e4e4e0; --accent:#b05730; --ok:#2f6f4f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#131314; --card:#1b1b1d; --ink:#f2f2ef; --muted:#9a9a94; --line:#2e2e31;
            --accent:#d8825a; --ok:#6fc79b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); padding:32px 16px;
         font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: var(--muted); margin: 0 0 8px; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
          color: var(--muted); word-break: break-all; margin: 0 0 24px; }
  form { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 8px 20px 20px; }
  .row { display:block; padding: 18px 0; border-bottom: 1px solid var(--line); }
  .row:last-of-type { border-bottom: none; }
  .meta { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin-bottom:8px; }
  .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight:600; }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border:1px solid var(--line); color:var(--muted); }
  .tag.req { color: var(--accent); border-color: var(--accent); }
  .desc { color: var(--ink); font-size: 13px; }
  .where { color: var(--muted); font-size: 12px; width:100%; }
  .field { display:flex; gap:8px; }
  input { flex:1; min-width:0; padding: 11px 12px; font-size: 14px; border-radius: 8px;
          border:1px solid var(--line); background: var(--bg); color: var(--ink);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .peek { padding: 0 12px; font-size: 12px; border-radius: 8px; border:1px solid var(--line);
          background: transparent; color: var(--muted); cursor: pointer; }
  .actions { display:flex; align-items:center; gap:14px; margin-top: 22px; flex-wrap: wrap; }
  button.save { background: var(--accent); color:#fff; border:none; padding: 11px 20px;
                font-size: 14px; font-weight: 600; border-radius: 8px; cursor: pointer; }
  button.save:disabled { opacity: .6; cursor: default; }
  .note { color: var(--muted); font-size: 12.5px; margin-top: 18px; }
  #result { margin-top: 16px; font-size: 14px; white-space: pre-wrap; }
  #result.ok { color: var(--ok); }
  #result.err { color: var(--accent); }
</style></head>
<body><main>
  <h1>Creator Partnership OS — API keys</h1>
  <p class="sub">Paste a key into a box and press Save. Blank boxes are left unchanged.</p>
  <p class="path">Writes to ${ENV_PATH} · served only to this computer on port ${port}</p>
  <form id="f">${rows}
    <div class="actions">
      <button class="save" type="submit">Save to .env</button>
      <span class="note" style="margin:0">Then run <code>npm run doctor</code></span>
    </div>
    <div id="result"></div>
  </form>
  <p class="note">This page is running on your own machine. Nothing typed here is uploaded
  anywhere or visible to Claude. Close the tab and press Ctrl+C in the terminal when you're done.</p>
</main>
<script>
  for (const b of document.querySelectorAll('.peek')) {
    b.addEventListener('click', () => {
      const i = b.previousElementSibling;
      i.type = i.type === 'password' ? 'text' : 'password';
      b.textContent = i.type === 'password' ? 'show' : 'hide';
    });
  }
  const form = document.getElementById('f');
  const result = document.getElementById('result');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button.save');
    button.disabled = true;
    result.className = '';
    result.textContent = 'Saving…';
    const payload = {};
    for (const input of form.querySelectorAll('input')) {
      if (input.value.trim()) payload[input.name] = input.value.trim();
    }
    try {
      const response = await fetch('/save?t=${TOKEN}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      result.className = data.ok ? 'ok' : 'err';
      result.textContent = data.message;
      if (data.ok) for (const input of form.querySelectorAll('input')) input.value = '';
    } catch (error) {
      result.className = 'err';
      result.textContent = 'Could not reach the local server — is it still running?';
    }
    button.disabled = false;
  });
</script>
</body></html>`;
}

async function handleSave(body: string): Promise<{ ok: boolean; message: string }> {
  let submitted: Record<string, string>;
  try {
    submitted = JSON.parse(body) as Record<string, string>;
  } catch {
    return { ok: false, message: 'Could not read the submitted values.' };
  }

  const entries = Object.entries(submitted).filter(
    ([key, value]) => CREDENTIAL_KEYS.includes(key) && typeof value === 'string' && value.trim(),
  );

  if (!entries.length) return { ok: false, message: 'Nothing to save — every box was empty.' };

  let contents = await readEnvFile();
  const saved: string[] = [];
  const warnings: string[] = [];

  for (const [key, raw] of entries) {
    const value = raw.trim();
    contents = upsert(contents, key, value);
    saved.push(`${key} = ${mask(value)}`);
    for (const warning of valueWarnings(key, value)) warnings.push(`${key}: ${warning}`);
  }

  await writeEnvFile(contents);

  const lines = [`Saved to ${ENV_PATH}`, ...saved.map((s) => `  ✔ ${s}`)];
  if (warnings.length) {
    lines.push('', 'Check these — they look unusual:', ...warnings.map((w) => `  ! ${w}`));
  }
  lines.push('', 'Now run:  npm run doctor');

  console.log(`\n✔ Saved ${saved.length} value(s) to .env`);
  for (const line of saved) console.log(`  ${line}`);
  console.log('\nNext: npm run doctor   (Ctrl+C here when you are done)\n');

  return { ok: true, message: lines.join('\n') };
}

async function main(): Promise<void> {
  const values = parseEnv(await readEnvFile());

  const server = http.createServer(async (request, response) => {
    if (!isLoopback(request)) {
      response.writeHead(403).end('This page is only available on this computer.');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('t') !== TOKEN) {
      response.writeHead(403).end('Missing or wrong token — use the link printed in the terminal.');
      return;
    }

    if (request.method === 'POST' && url.pathname === '/save') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 100_000) request.destroy();
      });
      request.on('end', async () => {
        const result = await handleSave(body);
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(result));
      });
      return;
    }

    if (url.pathname === '/') {
      const port = (server.address() as { port: number }).port;
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(page(parseEnv(await readEnvFile()), port));
      return;
    }

    response.writeHead(404).end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const link = `http://127.0.0.1:${port}/?t=${TOKEN}`;

  const filled = CREDENTIAL_KEYS.filter((key) => values.get(key)).length;

  console.log('\n  Creator Partnership OS — key setup');
  console.log(`  ${filled} of ${CREDENTIAL_KEYS.length} credentials currently set\n`);
  console.log('  Open this link in your browser:\n');
  console.log(`    ${link}\n`);
  console.log('  It works only on this computer. Press Ctrl+C here when you are done.\n');

  // Best effort: open the default browser. Harmless if it fails.
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} "${link}"`, () => {
    /* the printed link is the real interface */
  });
}

await main();
