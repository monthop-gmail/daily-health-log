/**
 * Daily Log — บันทึกกิจวัตรประจำวัน / สังเกตสุขภาพ
 * Cloudflare Worker + D1
 *
 * API (ต้องล็อกอินทุกเส้น ยกเว้น /api/login):
 *   POST /api/login        {password}            → ตั้ง cookie session
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/entries?from=&to=&limit=           → รายการในช่วงเวลา (epoch ms)
 *   POST /api/entries      {category, text?, level?, ts?}  → สร้างรายการเดียว (สำหรับ Shortcuts/สคริปต์)
 *   POST /api/sync         {ops:[{type:'put',entry}|{type:'del',id,updated_at}]}
 *   GET  /api/suggestions                        → ข้อความที่ใช้บ่อยของแต่ละหมวด
 *   GET  /api/categories / PUT /api/categories   → ปุ่มหมวดบันทึกด่วน
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_PASSWORD?: string;
  API_TOKEN?: string;
}

type Entry = {
  id: string;
  ts: number;
  category: string;
  text: string;
  level: number | null;
  updated_at: number;
};

type Category = {
  key: string;
  label: string;
  emoji: string;
  scale?: boolean;
  hidden?: boolean;
  presets?: string[];
};

const COOKIE = 'dl_session';
const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;
const MAX_LOGIN_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CAT_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const MIN_TS = Date.UTC(2000, 0, 1);

export const DEFAULT_CATEGORIES: Category[] = [
  { key: 'med', label: 'ยา', emoji: '💊', presets: ['ยาเช้า', 'ยากลางวัน', 'ยาเย็น', 'ยาก่อนนอน'] },
  { key: 'food', label: 'อาหาร', emoji: '🍚', presets: ['มื้อเช้า', 'มื้อกลางวัน', 'มื้อเย็น', 'ของว่าง'] },
  { key: 'water', label: 'ดื่มน้ำ', emoji: '💧', presets: ['1 แก้ว', '2 แก้ว', '1 ขวด'] },
  { key: 'symptom', label: 'อาการ', emoji: '🤒', scale: true, presets: ['ปวดหัว', 'เวียนหัว', 'คลื่นไส้', 'เหนื่อยง่าย', 'ปวดท้อง', 'ไอ'] },
  { key: 'vitals', label: 'วัดค่า', emoji: '🩺', presets: ['ความดัน ', 'ชีพจร ', 'น้ำตาล ', 'น้ำหนัก ', 'อุณหภูมิ '] },
  { key: 'bowel', label: 'ขับถ่าย', emoji: '🚽', presets: ['ปกติ', 'ท้องผูก', 'ท้องเสีย', 'ปัสสาวะ'] },
  { key: 'sleep', label: 'เข้านอน', emoji: '😴', presets: [] },
  { key: 'wake', label: 'ตื่นนอน', emoji: '🌅', presets: ['หลับดี', 'หลับไม่สนิท', 'ตื่นกลางดึก'] },
  { key: 'exercise', label: 'ออกกำลัง', emoji: '🚶', presets: ['เดิน 30 นาที', 'ยืดเหยียด'] },
  { key: 'mood', label: 'อารมณ์', emoji: '🙂', scale: true, presets: ['สดชื่น', 'ปกติ', 'เครียด', 'กังวล', 'อ่อนเพลีย'] },
  { key: 'note', label: 'จดไว้', emoji: '📝', presets: [] },
];

const enc = new TextEncoder();

// ---------- helpers ----------

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function b64url(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** เทียบสตริงแบบไม่รั่วเวลา (hash ก่อนเพื่อให้ยาวเท่ากัน) */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

// ไม่ยอมเปิดใช้ถ้ารหัสผ่านว่าง/สั้น/เป็นค่าตัวอย่าง (กันคน deploy แล้วลืมตั้ง)
const WEAK_PASSWORDS = new Set(['change-me', 'changeme', 'password', '12345678', 'test1234']);
function passwordReady(env: Env): boolean {
  const p = env.APP_PASSWORD ?? '';
  return p.length >= 8 && !WEAK_PASSWORDS.has(p.toLowerCase());
}

// session ผูกกับรหัสผ่าน: เปลี่ยนรหัสผ่าน = ทุกเครื่องหลุดล็อกอิน
function sessionKey(env: Env): string {
  return 'daily-log-session:v1:' + (env.APP_PASSWORD ?? '');
}

async function makeSession(env: Env): Promise<{ token: string; maxAge: number }> {
  const exp = Date.now() + SESSION_TTL_MS;
  return { token: `${exp}.${await hmac(sessionKey(env), String(exp))}`, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

async function checkSession(env: Env, token: string): Promise<boolean> {
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  return safeEqual(sig, await hmac(sessionKey(env), expStr));
}

function cookieHeader(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function isAuthed(req: Request, env: Env): Promise<boolean> {
  if (!passwordReady(env)) return false;
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return !!env.API_TOKEN && (await safeEqual(auth.slice(7).trim(), env.API_TOKEN));
  }
  const token = getCookie(req, COOKIE);
  return token ? checkSession(env, token) : false;
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function validateEntry(e: any, now: number): Entry | string {
  if (!e || typeof e !== 'object') return 'bad_entry';
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return 'bad_id';
  const ts = Number(e.ts);
  if (!Number.isFinite(ts) || ts < MIN_TS || ts > now + 2 * 86400000) return 'bad_ts';
  if (typeof e.category !== 'string' || !CAT_KEY_RE.test(e.category)) return 'bad_category';
  const text = e.text == null ? '' : String(e.text).trim();
  if (text.length > 4000) return 'text_too_long';
  const level = e.level == null || e.level === '' ? null : Number(e.level);
  if (level !== null && (!Number.isInteger(level) || level < 1 || level > 5)) return 'bad_level';
  let updated = Number(e.updated_at);
  if (!Number.isFinite(updated) || updated < MIN_TS || updated > now + 60000) updated = now;
  return { id: e.id, ts: Math.round(ts), category: e.category, text, level, updated_at: Math.round(updated) };
}

function validateCategories(input: any): Category[] | string {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40) return 'bad_categories';
  const seen = new Set<string>();
  const out: Category[] = [];
  for (const c of input) {
    if (!c || typeof c !== 'object') return 'bad_category';
    const key = String(c.key ?? '');
    if (!CAT_KEY_RE.test(key) || seen.has(key)) return 'bad_category_key';
    seen.add(key);
    const label = String(c.label ?? '').trim();
    if (!label || label.length > 30) return 'bad_category_label';
    const emoji = String(c.emoji ?? '').trim().slice(0, 16);
    const presets = Array.isArray(c.presets)
      ? c.presets.map((p: unknown) => String(p).slice(0, 60)).filter((p: string) => p.trim()).slice(0, 20)
      : [];
    out.push({ key, label, emoji, scale: !!c.scale, hidden: !!c.hidden, presets });
  }
  return out;
}

async function getCategories(env: Env): Promise<Category[]> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('categories').first<{ value: string }>();
  if (row) {
    try {
      const parsed = validateCategories(JSON.parse(row.value));
      if (typeof parsed !== 'string') return parsed;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_CATEGORIES;
}

function upsertStmt(env: Env, e: Entry, now: number): D1PreparedStatement {
  // last-write-wins ตาม updated_at — ข้อมูลที่ค้างส่งตอนออฟไลน์จะไม่ทับของที่ใหม่กว่า
  return env.DB.prepare(
    `INSERT INTO entries (id, ts, category, text, level, deleted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?7, ?6)
     ON CONFLICT(id) DO UPDATE SET
       ts = excluded.ts, category = excluded.category, text = excluded.text,
       level = excluded.level, deleted = 0, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= entries.updated_at`
  ).bind(e.id, e.ts, e.category, e.text, e.level, e.updated_at, now);
}

// ---------- routes ----------

async function handleLogin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!passwordReady(env)) return json({ error: 'password_not_configured' }, 503);
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();

  const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE ip = ?')
    .bind(ip)
    .first<{ count: number; window_start: number }>();
  if (row && now - row.window_start < LOGIN_WINDOW_MS && row.count >= MAX_LOGIN_FAILS) {
    return json({ error: 'too_many_attempts' }, 429);
  }

  const body = await readJson(req);
  const ok = typeof body?.password === 'string' && (await safeEqual(body.password, env.APP_PASSWORD ?? ''));
  if (!ok) {
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END`
    )
      .bind(ip, now, LOGIN_WINDOW_MS)
      .run();
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: 'wrong_password' }, 401);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const { token, maxAge } = await makeSession(env);
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, token, maxAge) });
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // กัน CSRF: คำขอที่แก้ข้อมูลต้องมาจาก origin เดียวกัน
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return json({ error: 'bad_origin' }, 403);
  }

  if (path === '/api/login' && method === 'POST') return handleLogin(req, env, url);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, '', 0) });
  }

  if (!(await isAuthed(req, env))) {
    return json({ error: passwordReady(env) ? 'unauthorized' : 'password_not_configured' }, 401);
  }

  const now = Date.now();

  if (path === '/api/me' && method === 'GET') return json({ ok: true, now });

  if (path === '/api/entries' && method === 'GET') {
    const from = Number(url.searchParams.get('from') ?? 0) || 0;
    const to = Number(url.searchParams.get('to') ?? 0) || now + 2 * 86400000;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 5000) || 5000, 1), 50000);
    const { results } = await env.DB.prepare(
      `SELECT id, ts, category, text, level, updated_at FROM entries
       WHERE deleted = 0 AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`
    )
      .bind(from, to, limit)
      .all<Entry>();
    return json({ entries: results });
  }

  if (path === '/api/entries' && method === 'POST') {
    // สร้างรายการเดียวแบบง่าย — ใช้กับ iOS Shortcuts / curl
    const body = await readJson(req);
    const cats = await getCategories(env);
    const raw = String(body?.category ?? '').trim();
    const cat = cats.find((c) => c.key === raw || c.label === raw);
    if (!cat) return json({ error: 'unknown_category', categories: cats.map((c) => c.label) }, 400);
    const v = validateEntry(
      { id: crypto.randomUUID(), ts: body.ts ?? now, category: cat.key, text: body.text, level: body.level, updated_at: now },
      now
    );
    if (typeof v === 'string') return json({ error: v }, 400);
    await upsertStmt(env, v, now).run();
    return json({ ok: true, entry: v }, 201);
  }

  if (path === '/api/sync' && method === 'POST') {
    const body = await readJson(req);
    const ops = body?.ops;
    if (!Array.isArray(ops) || ops.length > 500) return json({ error: 'bad_ops' }, 400);
    const stmts: D1PreparedStatement[] = [];
    const rejected: { index: number; error: string }[] = [];
    ops.forEach((op: any, index: number) => {
      if (op?.type === 'put') {
        const v = validateEntry(op.entry, now);
        if (typeof v === 'string') rejected.push({ index, error: v });
        else stmts.push(upsertStmt(env, v, now));
      } else if (op?.type === 'del') {
        if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return rejected.push({ index, error: 'bad_id' });
        let u = Number(op.updated_at);
        if (!Number.isFinite(u) || u > now + 60000) u = now;
        stmts.push(
          env.DB.prepare('UPDATE entries SET deleted = 1, updated_at = ?2 WHERE id = ?1 AND updated_at <= ?2').bind(op.id, u)
        );
      } else {
        rejected.push({ index, error: 'bad_op' });
      }
    });
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, applied: stmts.length, rejected });
  }

  if (path === '/api/suggestions' && method === 'GET') {
    const since = now - 120 * 86400000;
    const { results } = await env.DB.prepare(
      `SELECT category, text FROM (
         SELECT category, text, MAX(ts) AS last,
                ROW_NUMBER() OVER (PARTITION BY category ORDER BY COUNT(*) DESC, MAX(ts) DESC) AS rn
         FROM entries
         WHERE deleted = 0 AND text <> '' AND ts > ? AND length(text) <= 60
         GROUP BY category, text
       ) WHERE rn <= 8 ORDER BY category, rn`
    )
      .bind(since)
      .all<{ category: string; text: string }>();
    const out: Record<string, string[]> = {};
    for (const r of results) (out[r.category] ||= []).push(r.text);
    return json({ suggestions: out });
  }

  if (path === '/api/categories' && method === 'GET') {
    return json({ categories: await getCategories(env) });
  }

  if (path === '/api/categories' && method === 'PUT') {
    const body = await readJson(req);
    const v = validateCategories(body?.categories);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('categories', ?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(JSON.stringify(v), now)
      .run();
    return json({ ok: true, categories: v });
  }

  if (path === '/api/categories/reset' && method === 'POST') {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'categories'").run();
    return json({ ok: true, categories: DEFAULT_CATEGORIES });
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status);
      console.error('api_error', err);
      return json({ error: 'server_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
