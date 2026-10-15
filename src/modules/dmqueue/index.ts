import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { outputsRoot } from '../../lib/paths.js';
import { approveDmVariant, markDmSent } from '../outreach/index.js';

// The DM queue: DMs are never sent automatically. This local page lists
// approved, unsent DMs oldest first with a "Copy & open" button (copies the
// text, opens the DM), "Sent" (marks it SENT now, so the follow-up clock
// starts) and "Skip" (leaves it queued). Drafts that still need a variant
// picked are listed below with "Approve". Bound to the LAN so it works on a
// phone; every request needs the token in the URL.

const log = createLogger('dmqueue');
export const DM_QUEUE_PORT = Number(process.env.DM_QUEUE_PORT ?? 4317);

async function token(): Promise<string> {
  const file = path.join(outputsRoot(), '_pipeline', 'dmqueue-token');
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    const t = crypto.randomBytes(12).toString('hex');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, t, { mode: 0o600 });
    return t;
  }
}

function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export async function dmQueueUrl(host = 'localhost'): Promise<string> {
  return `http://${host}:${DM_QUEUE_PORT}/?t=${await token()}`;
}

/** Where the DM is sent from, per channel. */
export function openUrl(channel: string, handle: string, profileUrl: string | null): string {
  if (channel === 'IG_DM') return `https://ig.me/m/${handle}`;
  if (channel === 'YT_ABOUT') return `${(profileUrl ?? `https://www.youtube.com/@${handle}`).replace(/\/+$/, '')}/about`;
  if (channel === 'X_DM') return `https://x.com/${handle}`; // X has no DM deep link by handle; Message button is on the profile
  return profileUrl ?? '#';
}

export async function queueData() {
  const msgs = await prisma.outreachMessage.findMany({
    where: { channel: { not: 'EMAIL' }, status: { in: ['DRAFT', 'APPROVED'] }, creator: { doNotContact: false, status: { not: 'RETIRED' } } },
    include: { creator: { select: { handle: true, displayName: true, profileUrl: true } } },
    orderBy: [{ createdAt: 'asc' }, { variant: 'asc' }],
  });
  const item = (m: (typeof msgs)[number]) => ({
    id: m.id,
    handle: m.creator.handle,
    name: m.creator.displayName,
    channel: m.channel,
    sequence: m.sequence,
    variant: m.variant,
    body: m.body,
    createdAt: m.createdAt,
    open: openUrl(m.channel, m.creator.handle, m.creator.profileUrl),
  });
  const ready = msgs.filter((m) => m.status === 'APPROVED').map(item);
  const readyKeys = new Set(msgs.filter((m) => m.status === 'APPROVED').map((m) => `${m.creatorId}:${m.sequence}:${m.channel}`));
  const drafts = msgs.filter((m) => m.status === 'DRAFT' && !readyKeys.has(`${m.creatorId}:${m.sequence}:${m.channel}`)).map(item);
  return { ready, drafts };
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DM queue</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e3e1dc;--accent:#2f5bd3;--ok:#1f8a4c;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1e1e22;--ink:#ececf0;--mute:#9a9aa3;--line:#2e2e34;--accent:#7d9bff;--ok:#4fc483;--warn:#e0a24a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 2px}h2{font-size:15px;color:var(--mute);margin:24px 0 8px;text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--mute);font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:10px 0}
.top{display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap}.h{font-weight:600}.tag{font-size:12px;color:var(--mute)}
pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:10px 0;background:var(--bg);border-radius:8px;padding:10px}
.btns{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px 14px;min-height:44px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.ok{color:var(--ok);border-color:var(--ok)}
.done{opacity:.45}.msg{font-size:14px;color:var(--ok);min-height:1.2em}.empty{color:var(--mute);padding:8px 0}
</style></head><body><main>
<h1>DM queue</h1><div class="sub">Nothing here is ever sent automatically. Copy &amp; open, paste, send — then tap Sent.</div>
<h2>Ready to send</h2><div id="ready"></div>
<h2>Drafts — pick a variant</h2><div id="drafts"></div>
<textarea id="clip" style="position:fixed;left:-9999px;top:0" aria-hidden="true"></textarea>
</main><script>
const T=new URLSearchParams(location.search).get('t');
const api=(p,b)=>fetch(p+'?t='+T,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:{}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json()});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const label={IG_DM:'Instagram DM',YT_ABOUT:'YouTube About',X_DM:'X DM',MANUAL:'Manual'};
function copy(text){
  // Works on http:// LAN addresses too, where navigator.clipboard is unavailable.
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).catch(()=>{});return}
  const t=document.getElementById('clip');t.value=text;t.select();t.setSelectionRange(0,text.length);try{document.execCommand('copy')}catch(e){}
}
function card(m,ready){
  const el=document.createElement('div');el.className='card';
  el.innerHTML='<div class="top"><span class="h">@'+esc(m.handle)+'</span><span class="tag">'+esc(label[m.channel]||m.channel)+' · message '+m.sequence+(ready?'':' · variant '+esc(m.variant))+' · '+new Date(m.createdAt).toLocaleDateString()+'</span></div><pre>'+esc(m.body)+'</pre><div class="btns"></div><div class="msg"></div>';
  const b=el.querySelector('.btns'),msg=el.querySelector('.msg');
  const add=(txt,cls,fn)=>{const x=document.createElement('button');x.textContent=txt;if(cls)x.className=cls;x.onclick=fn;b.appendChild(x);return x};
  if(ready){
    add('Copy & open','primary',()=>{copy(m.body);window.open(m.open,'_blank','noopener');msg.textContent='Copied — paste it into the DM.'});
    add('Sent','ok',async()=>{try{const r=await api('/api/sent',{id:m.id});el.classList.add('done');b.remove();msg.textContent='Marked sent'+(r.nextDueAt?' · follow-up due '+new Date(r.nextDueAt).toLocaleDateString():' · that was the last message');}catch(e){msg.textContent=e.message}});
    add('Skip','',()=>{el.remove()});
  }else{
    add('Approve this variant','primary',async()=>{try{await api('/api/approve',{id:m.id});load()}catch(e){msg.textContent=e.message}});
  }
  return el;
}
async function load(){
  const d=await api('/api/queue');
  for(const [id,list,ready] of [['ready',d.ready,true],['drafts',d.drafts,false]]){
    const box=document.getElementById(id);box.innerHTML='';
    if(!list.length)box.innerHTML='<div class="empty">Nothing here.</div>';
    for(const m of list)box.appendChild(card(m,ready));
  }
}
load().catch(e=>document.body.insertAdjacentHTML('beforeend','<p style="padding:16px">'+esc(e.message)+'</p>'));
</script></body></html>`;

async function body(req: http.IncomingMessage): Promise<{ id?: string }> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as { id?: string }) : {};
}

export async function startDmQueue(host = '0.0.0.0'): Promise<http.Server> {
  const t = await token();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, type: string, data: string) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(data);
    };
    if (url.searchParams.get('t') !== t) return send(403, 'text/plain', 'Forbidden — open the link with its ?t= token.');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE);
      if (req.method === 'GET' && url.pathname === '/api/queue') return send(200, 'application/json', JSON.stringify(await queueData()));
      if (req.method === 'POST' && url.pathname === '/api/approve') {
        const { id } = await body(req);
        await approveDmVariant(String(id));
        return send(200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/sent') {
        const { id } = await body(req);
        const r = await markDmSent(String(id));
        log.info(`DM ${id} marked SENT`);
        return send(200, 'application/json', JSON.stringify(r));
      }
      return send(404, 'text/plain', 'Not found');
    } catch (error) {
      return send(400, 'text/plain', (error as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(DM_QUEUE_PORT, host, resolve));
  const lan = lanAddress();
  log.info(`DM queue on ${await dmQueueUrl()}${lan ? ` · phone (same Wi-Fi): ${await dmQueueUrl(lan)}` : ''}`);
  return server;
}
