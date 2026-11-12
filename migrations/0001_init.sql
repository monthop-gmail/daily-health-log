-- บันทึกแต่ละรายการ
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,          -- UUID สร้างจากฝั่งเครื่อง (รองรับบันทึกตอนออฟไลน์)
  ts          INTEGER NOT NULL,          -- เวลาที่เหตุการณ์เกิดขึ้น (epoch ms) — บันทึกย้อนหลังได้
  category    TEXT NOT NULL,             -- key ของหมวด เช่น med, food, symptom
  text        TEXT NOT NULL DEFAULT '',  -- รายละเอียด
  level       INTEGER,                   -- ระดับ 1–5 (สำหรับหมวดที่มีระดับ เช่น อาการ อารมณ์)
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_ts  ON entries (deleted, ts);
CREATE INDEX IF NOT EXISTS idx_entries_cat ON entries (category, ts);

-- ค่าตั้ง เช่น รายการหมวดปุ่มบันทึกด่วน
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- กันเดารหัสผ่าน
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
