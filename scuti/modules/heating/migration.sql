CREATE TABLE heating_sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  token_hash  TEXT    NOT NULL UNIQUE,   -- SHA-256 hex du token ; le token en clair n'est jamais stocké
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT
);

CREATE TABLE heating_rooms (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id          INTEGER NOT NULL REFERENCES heating_sites(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  sensor_name      TEXT    NOT NULL,
  plug_name        TEXT    NOT NULL,
  default_setpoint REAL    NOT NULL DEFAULT 17,
  hysteresis       REAL    NOT NULL DEFAULT 0.5,
  enabled          INTEGER NOT NULL DEFAULT 1,
  mode             TEXT    NOT NULL DEFAULT 'auto' CHECK (mode IN ('off','manual','auto')),
  manual_setpoint  REAL,
  manual_until     TEXT
);

CREATE TABLE heating_rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id   INTEGER NOT NULL REFERENCES heating_rooms(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  priority  INTEGER NOT NULL DEFAULT 10,
  enabled   INTEGER NOT NULL DEFAULT 1,
  days      TEXT    NOT NULL,          -- JSON : [1,2,3,4,5]  (1=lundi … 7=dimanche)
  time_from TEXT    NOT NULL,          -- "07:00"
  time_to   TEXT    NOT NULL,          -- "22:00"
  setpoint  REAL    NOT NULL
);

CREATE TABLE heating_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL REFERENCES heating_rooms(id) ON DELETE CASCADE,
  temperature REAL,
  humidity    REAL,
  heating     INTEGER NOT NULL,
  setpoint    REAL,
  measured_at TEXT    NOT NULL
);

CREATE INDEX idx_heating_readings_room_time ON heating_readings(room_id, measured_at);
