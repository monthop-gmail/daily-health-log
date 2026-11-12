/**
 * ยา / มื้อยา / นัดหมอ / การแจ้งเตือน
 *
 *   GET    /api/care                  → {meds, slots, tz, appointments}
 *   PUT    /api/meds/:id              {med}
 *   DELETE /api/meds/:id
 *   PUT    /api/med-slots             {slots, tz?}
 *   POST   /api/meds/take             {slot, date?, ts?, note?, taken?}  → บันทึกว่าใช้ยาชุดนี้แล้ว (ใช้จากปุ่มบนการแจ้งเตือน)
 *   PUT    /api/appointments/:id      {appointment}
 *   DELETE /api/appointments/:id
 *   GET    /api/push/key              → VAPID public key
 *   POST   /api/push/subscribe        {subscription, tz?}
 *   POST   /api/push/unsubscribe      {endpoint}
 *   POST   /api/push/test
 */
import { Env, json, readJson, ID_RE, MIN_TS, getSetting, putSetting, clip } from './util';
import { generateVapidKeys, sendPush, VapidKeys, PushSub } from './push';

export type Slot = { key: string; label: string; time: string; remind: boolean };
export type Med = {
  id: string;
  name: string;
  dose: string;
  method: string;
  instructions: string;
  purpose: string;
  notes: string;
  slots: Record<string, string>; // key มื้อ → ขนาดเฉพาะมื้อ ('' = ใช้ขนาดปกติ)
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  sort: number;
  created_at?: number;
  updated_at: number;
};
export type Appt = {
  id: string;
  ts: number;
  title: string;
  place: string;
  doctor: string;
  details: string;
  remind: number[]; // นาทีก่อนนัด
  status: 'scheduled' | 'done' | 'cancelled';
  result: string;
  updated_at: number;
};

export const DEFAULT_SLOTS: Slot[] = [
  { key: 'morning', label: 'เช้า', time: '08:00', remind: true },
  { key: 'noon', label: 'กลางวัน', time: '12:00', remind: true },
  { key: 'evening', label: 'เย็น', time: '18:00', remind: true },
  { key: 'bedtime', label: 'ก่อนนอน', time: '21:00', remind: true },
];
const DEFAULT_TZ = 'Asia/Bangkok';
const SLOT_KEY_RE = /^[a-z0-9_]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = new Set(['scheduled', 'done', 'cancelled']);
const DAY = 86400000;

// ---------- เวลาและโซนเวลา ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function localParts(ts: number, tz: string): { date: string; minutes: number } {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(ts)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const dayNum = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / DAY;

// ---------- ยา ----------

function rowMed(r: any): Med {
  let slots: Record<string, string> = {};
  try {
    slots = JSON.parse(r.slots || '{}');
  } catch {}
  return {
    id: r.id,
    name: r.name,
    dose: r.dose,
    method: r.method,
    instructions: r.instructions,
    purpose: r.purpose,
    notes: r.notes,
    slots,
    start_date: r.start_date ?? null,
    end_date: r.end_date ?? null,
    active: !!r.active,
    sort: r.sort ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function validateMed(id: string, m: any): Med | string {
  if (!m || typeof m !== 'object') return 'bad_med';
  const name = clip(m.name, 100);
  if (!name) return 'med_name_required';
  const slots: Record<string, string> = {};
  if (m.slots && typeof m.slots === 'object' && !Array.isArray(m.slots)) {
    for (const [k, v] of Object.entries(m.slots).slice(0, 10)) {
      if (!SLOT_KEY_RE.test(k)) return 'bad_slot_key';
      slots[k] = clip(v, 60);
    }
  }
  const date = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
  return {
    id,
    name,
    dose: clip(m.dose, 60),
    method: clip(m.method, 20) || 'กิน',
    instructions: clip(m.instructions, 200),
    purpose: clip(m.purpose, 100),
    notes: clip(m.notes, 1000),
    slots,
    start_date: date(m.start_date),
    end_date: date(m.end_date),
    active: m.active !== false,
    sort: Number.isFinite(Number(m.sort)) ? Math.round(Number(m.sort)) : 0,
    updated_at: Date.now(),
  };
}

async function listMeds(env: Env): Promise<Med[]> {
  const { results } = await env.DB.prepare('SELECT * FROM meds ORDER BY active DESC, sort, name').all();
  return results.map(rowMed);
}

function isDue(m: Med, slot: string, date: string): boolean {
  return m.active && slot in m.slots && (!m.start_date || m.start_date <= date) && (!m.end_date || date <= m.end_date);
}

/** ข้อความยาหนึ่งตัวในมื้อ เช่น "Amlodipine 5 mg 1 เม็ด (หลังอาหาร)" */
function medText(m: Med, slot: string, withInstr: boolean): string {
  const dose = (m.slots[slot] || m.dose || '').trim();
  const base = [m.name, dose].filter(Boolean).join(' ');
  return withInstr && m.instructions ? `${base} (${m.instructions})` : base;
}

function validateSlots(input: any): Slot[] | string {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) return 'bad_slots';
  const seen = new Set<string>();
  const out: Slot[] = [];
  for (const s of input) {
    const key = String(s?.key ?? '');
    if (!SLOT_KEY_RE.test(key) || seen.has(key)) return 'bad_slot_key';
    seen.add(key);
    const label = clip(s.label, 20);
    if (!label) return 'bad_slot_label';
    const time = String(s.time ?? '');
    if (!TIME_RE.test(time)) return 'bad_slot_time';
    out.push({ key, label, time, remind: s.remind !== false });
  }
  return out;
}

const getSlots = (env: Env) => getSetting<Slot[]>(env, 'med_slots', DEFAULT_SLOTS);
const getTz = async (env: Env) => {
  const tz = await getSetting<string>(env, 'tz', DEFAULT_TZ);
  return validTz(tz) ? tz : DEFAULT_TZ;
};

async function takenAlready(env: Env, slot: string, date: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM entries WHERE deleted = 0 AND meta IS NOT NULL AND ts > ?1
       AND json_extract(meta, '$.slot') = ?2 AND json_extract(meta, '$.date') = ?3 LIMIT 1`
  )
    .bind(now - 10 * DAY, slot, date)
    .first();
  return !!row;
}

// ---------- นัดหมอ ----------

function rowAppt(r: any): Appt {
  let remind: number[] = [];
  try {
    remind = JSON.parse(r.remind || '[]');
  } catch {}
  return {
    id: r.id,
    ts: r.ts,
    title: r.title,
    place: r.place,
    doctor: r.doctor,
    details: r.details,
    remind,
    status: r.status,
    result: r.result,
    updated_at: r.updated_at,
  };
}

function validateAppt(id: string, a: any, now: number): Appt | string {
  if (!a || typeof a !== 'object') return 'bad_appointment';
  const ts = Number(a.ts);
  if (!Number.isFinite(ts) || ts < MIN_TS || ts > now + 5 * 365 * DAY) return 'bad_ts';
  const title = clip(a.title, 120);
  if (!title) return 'title_required';
  const remind = Array.isArray(a.remind)
    ? [...new Set(a.remind.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 20160))].slice(0, 6)
    : [1440, 180];
  const status = STATUSES.has(a.status) ? a.status : 'scheduled';
  return {
    id,
    ts: Math.round(ts),
    title,
    place: clip(a.place, 120),
    doctor: clip(a.doctor, 120),
    details: clip(a.details, 4000),
    remind: remind as number[],
    status,
    result: clip(a.result, 4000),
    updated_at: now,
  };
}

async function listAppts(env: Env): Promise<Appt[]> {
  const { results } = await env.DB.prepare('SELECT * FROM appointments ORDER BY ts DESC LIMIT 500').all();
  return results.map(rowAppt);
}

// ไฟล์ปฏิทิน (.ics) สำหรับเพิ่มนัดลงแอปปฏิทินในมือถือ พร้อมการเตือนของปฏิทินเอง
function apptIcs(a: Appt, now: number): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const dt = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (line: string) => {
    // RFC 5545: บรรทัดละไม่เกิน 75 ไบต์ โดยไม่ตัดกลางตัวอักษร UTF-8
    let out = '';
    let cur = '';
    let len = 0;
    let limit = 75;
    for (const ch of line) {
      const n = new TextEncoder().encode(ch).length;
      if (len + n > limit) {
        out += cur + '\r\n ';
        cur = '';
        len = 0;
        limit = 74;
      }
      cur += ch;
      len += n;
    }
    return out + cur;
  };
  const desc = [a.doctor && `แพทย์/แผนก: ${a.doctor}`, a.details].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//daily-health-log//TH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${a.id}@daily-health-log`,
    `DTSTAMP:${dt(now)}`,
    `DTSTART:${dt(a.ts)}`,
    `DTEND:${dt(a.ts + 3600000)}`,
    `SUMMARY:${esc(`นัดหมอ: ${a.title}`)}`,
    ...(a.place ? [`LOCATION:${esc(a.place)}`] : []),
    ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []),
    ...a.remind.flatMap((min) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(a.title)}`, `TRIGGER:-PT${min}M`, 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- push ----------

async function getVapid(env: Env): Promise<VapidKeys> {
  const existing = await getSetting<VapidKeys | null>(env, 'vapid', null);
  if (existing?.publicKey && existing.privateJwk) return existing;
  const keys = await generateVapidKeys();
  await putSetting(env, 'vapid', keys);
  return keys;
}

function validEndpoint(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 1000) return false;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return true;
    // อนุญาต http เฉพาะเครื่องตัวเอง (ใช้ทดสอบ)
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

export async function sendToAll(env: Env, payload: unknown): Promise<{ total: number; sent: number; failed: number }> {
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth, fails FROM push_subs').all<PushSub & { fails: number }>();
  if (!results.length) return { total: 0, sent: 0, failed: 0 };
  const keys = await getVapid(env);
  const subject = await getSetting<string>(env, 'app_origin', 'mailto:daily-health-log@users.noreply.github.com');
  let sent = 0;
  let failed = 0;
  const now = Date.now();
  await Promise.all(
    results.map(async (s) => {
      const status = await sendPush(s, payload, keys, subject);
      if (status >= 200 && status < 300) {
        sent++;
        await env.DB.prepare('UPDATE push_subs SET last_ok = ?2, fails = 0 WHERE endpoint = ?1').bind(s.endpoint, now).run();
      } else {
        failed++;
        if (status === 404 || status === 410 || s.fails >= 20) {
          // เครื่องยกเลิกการแจ้งเตือนแล้ว
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run();
        } else {
          await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').bind(s.endpoint).run();
        }
        console.warn('push_failed', status, new URL(s.endpoint).host);
      }
    })
  );
  return { total: results.length, sent, failed };
}

// ---------- routes ----------

export async function handleCare(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/care' && method === 'GET') {
    const [meds, appointments, slots, tz] = await Promise.all([listMeds(env), listAppts(env), getSlots(env), getTz(env)]);
    return json({ meds, appointments, slots, tz });
  }

  let m = path.match(/^\/api\/meds\/([A-Za-z0-9_-]{8,64})$/);
  if (m && method === 'PUT') {
    const body = await readJson(req);
    const v = validateMed(m[1], body?.med);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO meds (id, name, dose, method, instructions, purpose, notes, slots, start_date, end_date, active, sort, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, dose = excluded.dose, method = excluded.method,
         instructions = excluded.instructions, purpose = excluded.purpose, notes = excluded.notes, slots = excluded.slots,
         start_date = excluded.start_date, end_date = excluded.end_date, active = excluded.active, sort = excluded.sort,
         updated_at = excluded.updated_at`
    )
      .bind(v.id, v.name, v.dose, v.method, v.instructions, v.purpose, v.notes, JSON.stringify(v.slots), v.start_date, v.end_date, v.active ? 1 : 0, v.sort, now)
      .run();
    const saved = await env.DB.prepare('SELECT * FROM meds WHERE id = ?').bind(v.id).first();
    return json({ ok: true, med: rowMed(saved) });
  }
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM meds WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  if (path === '/api/med-slots' && method === 'PUT') {
    const body = await readJson(req);
    const v = validateSlots(body?.slots);
    if (typeof v === 'string') return json({ error: v }, 400);
    await putSetting(env, 'med_slots', v);
    if (validTz(body?.tz)) await putSetting(env, 'tz', body.tz);
    return json({ ok: true, slots: v });
  }

  if (path === '/api/meds/take' && method === 'POST') {
    const body = await readJson(req);
    const [slots, tz, meds] = await Promise.all([getSlots(env), getTz(env), listMeds(env)]);
    const slot = slots.find((s) => s.key === body?.slot);
    if (!slot) return json({ error: 'unknown_slot' }, 400);
    const date = typeof body?.date === 'string' && DATE_RE.test(body.date) ? body.date : localParts(now, tz).date;
    if (await takenAlready(env, slot.key, date, now)) return json({ ok: true, already: true });
    const due = meds.filter((x) => isDue(x, slot.key, date));
    const taken = Array.isArray(body?.taken) ? due.filter((x) => body.taken.includes(x.id)) : due;
    const skipped = due.filter((x) => !taken.includes(x));
    const note = clip(body?.note, 500);
    let text = `ยา${slot.label}: ${taken.map((x) => medText(x, slot.key, false)).join(', ') || '—'}`;
    if (skipped.length) text += ` · ไม่ได้ใช้: ${skipped.map((x) => x.name).join(', ')}`;
    if (note) text += `\n${note}`;
    const ts = Number.isFinite(Number(body?.ts)) && Number(body.ts) > MIN_TS && Number(body.ts) < now + DAY ? Math.round(Number(body.ts)) : now;
    const entry = {
      id: crypto.randomUUID(),
      ts,
      category: 'med',
      text,
      level: null,
      meta: { slot: slot.key, date, taken: taken.map((x) => x.id), skipped: skipped.map((x) => x.id) },
      updated_at: now,
    };
    await env.DB.prepare(
      `INSERT INTO entries (id, ts, category, text, level, meta, deleted, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6, ?6)`
    )
      .bind(entry.id, entry.ts, entry.category, entry.text, JSON.stringify(entry.meta), now)
      .run();
    return json({ ok: true, entry }, 201);
  }

  const ics = path.match(/^\/api\/appointments\/([A-Za-z0-9_-]{8,64})\/ics$/);
  if (ics && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(ics[1]).first();
    if (!row) return json({ error: 'not_found' }, 404);
    return new Response(apptIcs(rowAppt(row), now), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'attachment; filename="appointment.ics"',
        'cache-control': 'no-store',
      },
    });
  }

  m = path.match(/^\/api\/appointments\/([A-Za-z0-9_-]{8,64})$/);
  if (m && method === 'PUT') {
    const body = await readJson(req);
    const v = validateAppt(m[1], body?.appointment, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO appointments (id, ts, title, place, doctor, details, remind, status, result, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, title = excluded.title, place = excluded.place, doctor = excluded.doctor,
         details = excluded.details, remind = excluded.remind, status = excluded.status, result = excluded.result,
         updated_at = excluded.updated_at`
    )
      .bind(v.id, v.ts, v.title, v.place, v.doctor, v.details, JSON.stringify(v.remind), v.status, v.result, now)
      .run();
    return json({ ok: true, appointment: v });
  }
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM appointments WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  if (path === '/api/push/key' && method === 'GET') {
    const keys = await getVapid(env);
    const { results } = await env.DB.prepare('SELECT endpoint FROM push_subs').all<{ endpoint: string }>();
    return json({ publicKey: keys.publicKey, endpoints: results.map((r) => r.endpoint) });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const body = await readJson(req);
    const sub = body?.subscription;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (!validEndpoint(sub?.endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
      return json({ error: 'bad_subscription' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, p256dh, auth, ua, created_at, fails) VALUES (?1, ?2, ?3, ?4, ?5, 0)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, fails = 0`
    )
      .bind(sub.endpoint, p256dh, auth, clip(req.headers.get('user-agent'), 200), now)
      .run();
    if (validTz(body?.tz)) await putSetting(env, 'tz', body.tz);
    if (url.protocol === 'https:') await putSetting(env, 'app_origin', url.origin);
    return json({ ok: true });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body?.endpoint === 'string') await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(body.endpoint).run();
    return json({ ok: true });
  }

  if (path === '/api/push/test' && method === 'POST') {
    const r = await sendToAll(env, {
      type: 'test',
      tag: 'test',
      title: 'ทดสอบการแจ้งเตือน',
      body: 'ถ้าเห็นข้อความนี้ แปลว่าการเตือนยาและนัดหมอใช้งานได้แล้ว',
      url: '/#/settings',
    });
    return json({ ok: true, ...r });
  }

  return null;
}

// ---------- เตือนตามเวลา (Cron ทุกนาที) ----------

function whenText(ts: number, now: number, tz: string): string {
  const a = localParts(ts, tz);
  const b = localParts(now, tz);
  const days = dayNum(a.date) - dayNum(b.date);
  const time = `${String(Math.floor(a.minutes / 60)).padStart(2, '0')}:${String(a.minutes % 60).padStart(2, '0')}`;
  const dateText = new Intl.DateTimeFormat('th-TH', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ts);
  if (days <= 0) return `วันนี้ ${time}`;
  if (days === 1) return `พรุ่งนี้ ${time}`;
  return `อีก ${days} วัน (${dateText} ${time})`;
}

export async function runReminders(env: Env, now = Date.now()): Promise<{ queued: number; sent: number }> {
  const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>();
  if (!subs?.n) return { queued: 0, sent: 0 };

  const [tz, slots, allMeds] = await Promise.all([getTz(env), getSlots(env), listMeds(env)]);
  const { date, minutes } = localParts(now, tz);
  const notes: { key: string; payload: Record<string, unknown> }[] = [];

  // ยาแต่ละมื้อ: เตือนตอนถึงเวลา และย้ำอีกครั้งหลัง 60 นาทีถ้ายังไม่บันทึก
  for (const s of slots) {
    if (!s.remind) continue;
    const diff = minutes - toMin(s.time);
    if (diff < 0 || diff >= 90) continue;
    const due = allMeds.filter((x) => isDue(x, s.key, date));
    if (!due.length) continue;
    if (await takenAlready(env, s.key, date, now)) continue;
    const stage = diff >= 60 ? 1 : 0;
    notes.push({
      key: `med:${date}:${s.key}:${stage}`,
      payload: {
        type: 'med',
        slot: s.key,
        date,
        tag: `med-${date}-${s.key}`,
        title: stage ? `ยังไม่ได้บันทึกยา${s.label}` : `ถึงเวลายา${s.label} (${s.time})`,
        body: due.map((x) => '• ' + medText(x, s.key, true)).join('\n').slice(0, 1500),
        url: `/?take=${s.key}&date=${date}`,
      },
    });
  }

  // นัดหมอ: เตือนตามเวลาที่ตั้งไว้ล่วงหน้า
  const { results } = await env.DB.prepare(
    "SELECT * FROM appointments WHERE status = 'scheduled' AND ts > ?1 AND ts < ?2"
  )
    .bind(now, now + 15 * DAY)
    .all();
  for (const a of results.map(rowAppt)) {
    for (const off of a.remind) {
      const fireAt = a.ts - off * 60000;
      if (now < fireAt || now - fireAt > 6 * 3600000) continue;
      const lines = [a.title, [a.place, a.doctor].filter(Boolean).join(' · ')];
      if (a.details) lines.push(a.details.split('\n')[0]);
      notes.push({
        key: `appt:${a.id}:${a.ts}:${off}`,
        payload: {
          type: 'appt',
          id: a.id,
          tag: `appt-${a.id}`,
          title: `นัดหมอ${whenText(a.ts, now, tz)}`,
          body: lines.filter(Boolean).join('\n').slice(0, 1500),
          url: '/#/appts',
        },
      });
    }
  }

  let sent = 0;
  for (const n of notes) {
    // จองคีย์ก่อนส่ง กันส่งซ้ำแม้ cron ทับกัน
    const r = await env.DB.prepare('INSERT INTO reminders_sent (key, sent_at) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING')
      .bind(n.key, now)
      .run();
    if (!r.meta.changes) continue;
    const res = await sendToAll(env, n.payload);
    sent += res.sent;
    // ส่งไม่ถึงเครื่องไหนเลย (เช่น บริการ push ล่มชั่วคราว) → ปล่อยคีย์ให้ลองใหม่รอบถัดไป
    if (res.total > 0 && res.sent === 0) {
      await env.DB.prepare('DELETE FROM reminders_sent WHERE key = ?').bind(n.key).run();
    }
  }

  if (minutes % 60 === 0) {
    await env.DB.prepare('DELETE FROM reminders_sent WHERE sent_at < ?').bind(now - 30 * DAY).run();
  }
  return { queued: notes.length, sent };
}
