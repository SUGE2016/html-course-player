// Compatible with the original Python service; existing tables and rows are retained.
export const schema = `
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created REAL NOT NULL,
            chapter TEXT NOT NULL DEFAULT 'Demo', progress INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS students (
            session_id TEXT NOT NULL REFERENCES sessions(id), student_id TEXT NOT NULL,
            name TEXT NOT NULL, token_hash TEXT NOT NULL, joined REAL NOT NULL,
            PRIMARY KEY(session_id, student_id));
          CREATE TABLE IF NOT EXISTS rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
            question TEXT NOT NULL, started REAL NOT NULL, deadline REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'open', show_live INTEGER NOT NULL DEFAULT 1,
            previous_id INTEGER REFERENCES rounds(id));
          CREATE TABLE IF NOT EXISTS votes (
            round_id INTEGER NOT NULL REFERENCES rounds(id), student_id TEXT NOT NULL,
            choice INTEGER NOT NULL, submitted REAL NOT NULL,
            PRIMARY KEY(round_id, student_id));
          CREATE TABLE IF NOT EXISTS browser_sessions (
            token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
            student_id TEXT NOT NULL, browser_id TEXT NOT NULL, created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
            happened REAL NOT NULL, kind TEXT NOT NULL, browser_id TEXT NOT NULL,
            ip TEXT NOT NULL, old_id TEXT NOT NULL, student_id TEXT NOT NULL,
            user_agent TEXT NOT NULL, features TEXT NOT NULL, fingerprint TEXT NOT NULL,
            detail TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS lessons (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
            title TEXT NOT NULL, day TEXT NOT NULL, started REAL NOT NULL, ended REAL);
          CREATE TABLE IF NOT EXISTS star_awards (
            id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT NOT NULL REFERENCES lessons(id),
            student_id TEXT NOT NULL, name TEXT NOT NULL, reason TEXT NOT NULL,
            snapshot TEXT NOT NULL, confirmed REAL NOT NULL, version INTEGER NOT NULL);
        `;
