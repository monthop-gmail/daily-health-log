-- ข้อมูลประกอบของบันทึก (เช่น บันทึกทานยาชุดไหน วันไหน)
ALTER TABLE entries ADD COLUMN meta TEXT;

-- รายการยา
CREATE TABLE IF NOT EXISTS meds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                 -- ชื่อยา
  dose          TEXT NOT NULL DEFAULT '',      -- ขนาดต่อครั้ง เช่น 1 เม็ด, 5 ml, ทาบาง ๆ
  method        TEXT NOT NULL DEFAULT 'กิน',   -- กิน / ทา / หยอด / พ่น-สูด / ฉีด / อื่น ๆ
  instructions  TEXT NOT NULL DEFAULT '',      -- หลังอาหาร, ก่อนอาหาร 30 นาที ...
  purpose       TEXT NOT NULL DEFAULT '',      -- ใช้สำหรับ
  notes         TEXT NOT NULL DEFAULT '',      -- หมายเหตุ ผลข้างเคียงที่ต้องสังเกต
  slots         TEXT NOT NULL DEFAULT '{}',    -- {"morning":"", "evening":"½ เม็ด"} มื้อที่ใช้ + ขนาดเฉพาะมื้อ
  start_date    TEXT,                          -- YYYY-MM-DD (ไม่บังคับ)
  end_date      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- นัดหมอ
CREATE TABLE IF NOT EXISTS appointments (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,                  -- วันเวลานัด (epoch ms)
  title       TEXT NOT NULL,                     -- เช่น ตรวจติดตามความดัน
  place       TEXT NOT NULL DEFAULT '',          -- โรงพยาบาล / คลินิก / ห้องตรวจ
  doctor      TEXT NOT NULL DEFAULT '',          -- แพทย์ / แผนก
  details     TEXT NOT NULL DEFAULT '',          -- รายละเอียด การเตรียมตัว
  remind      TEXT NOT NULL DEFAULT '[1440,180]',-- เตือนล่วงหน้า (นาที)
  status      TEXT NOT NULL DEFAULT 'scheduled', -- scheduled / done / cancelled
  result      TEXT NOT NULL DEFAULT '',          -- ผลการตรวจ / คำแนะนำหมอ
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_ts ON appointments (status, ts);

-- เครื่องที่เปิดรับการแจ้งเตือน (Web Push)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT,
  created_at  INTEGER NOT NULL,
  last_ok     INTEGER,
  fails       INTEGER NOT NULL DEFAULT 0
);

-- กันส่งการแจ้งเตือนซ้ำ
CREATE TABLE IF NOT EXISTS reminders_sent (
  key      TEXT PRIMARY KEY,
  sent_at  INTEGER NOT NULL
);
