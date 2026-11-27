// MCP-Server (Streamable HTTP, zustandslos) für die Lifetracker-App.
// Bildet alle 17 Datenbereiche der App (gleiche Supabase-Tabelle
// lifetracker_kv_store, gleiches Blob-pro-Key-Format wie index.html) als
// MCP-Tools ab - lesend und schreibend. Zugriff nicht über OAuth, sondern
// über ein Geheimnis im URL-Pfad (siehe MCP_SECRET_TOKEN) - siehe README.md
// im selben Ordner. Die eigentliche Datenbank-Authentifizierung läuft über
// denselben Supabase-Auth-Login wie die App (Email/Passwort als Function-
// Secrets), damit Row Level Security exakt wie in der App greift.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MCP_EMAIL = Deno.env.get("MCP_EMAIL")!;
const MCP_PASSWORD = Deno.env.get("MCP_PASSWORD")!;
const MCP_SECRET_TOKEN = Deno.env.get("MCP_SECRET_TOKEN")!;

/* ============================================================
   AUTH — identischer Login-Flow wie die App (Email/Passwort -> Session),
   damit Row Level Security (user_id = auth.uid()) unverändert greift.
   ============================================================ */
type Session = { access_token: string; refresh_token: string; expires_at: number; user_id: string };
let cachedSession: Session | null = null;

async function loginWithPassword(): Promise<Session> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: MCP_EMAIL, password: MCP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Supabase-Login fehlgeschlagen (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user_id: data.user?.id,
  };
}

async function refreshSession(session: Session): Promise<Session | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user_id: data.user?.id,
  };
}

async function getSession(): Promise<Session> {
  if (cachedSession && cachedSession.expires_at - Date.now() > 60_000) return cachedSession;
  if (cachedSession?.refresh_token) {
    const refreshed = await refreshSession(cachedSession);
    if (refreshed) { cachedSession = refreshed; return refreshed; }
  }
  cachedSession = await loginWithPassword();
  return cachedSession;
}

async function supaFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const session = await getSession();
  return fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: { ...(options.headers as Record<string, string> | undefined), apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}` },
  });
}

/* ============================================================
   KV-STORE-ZUGRIFF — identische Blob-Repräsentation wie die App:
   die Spalte "value" ist text und enthält JSON.stringify(wert).
   ============================================================ */
async function getBlob<T>(key: string, fallback: T): Promise<T> {
  const res = await supaFetch(`/rest/v1/lifetracker_kv_store?key=eq.${encodeURIComponent(key)}&select=value`);
  if (!res.ok) throw new Error(`Supabase-Fehler beim Lesen von ${key}: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length || rows[0].value == null) return fallback;
  try { return JSON.parse(rows[0].value) as T; } catch { throw new Error(`Ungültige gespeicherte Daten unter ${key}`); }
}

async function setBlob(key: string, value: unknown): Promise<void> {
  const session = await getSession();
  const res = await supaFetch(`/rest/v1/lifetracker_kv_store`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value: JSON.stringify(value), user_id: session.user_id, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase-Fehler beim Schreiben von ${key}: ${res.status} ${await res.text()}`);
}

/* ============================================================
   HILFSFUNKTIONEN
   ============================================================ */
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function nowIso(): string {
  return new Date().toISOString();
}
function require(args: Record<string, unknown>, field: string): unknown {
  if (args[field] === undefined || args[field] === null || args[field] === "") {
    throw new Error(`Feld "${field}" ist erforderlich.`);
  }
  return args[field];
}
function findIndexOrThrow<T extends { id: string }>(list: T[], id: string, label: string): number {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) throw new Error(`${label} mit id "${id}" wurde nicht gefunden.`);
  return idx;
}

const INVERSE_RELATIONSHIP: Record<string, string> = {
  parent: "child", child: "parent",
  sibling: "sibling",
  partner: "partner",
  grandparent: "grandchild", grandchild: "grandparent",
  auntUncle: "nibling", nibling: "auntUncle",
  cousin: "cousin",
  friend: "friend",
};

/* ============================================================
   GENERISCHE HELFER FÜR DIE DREI WIEDERKEHRENDEN SPEICHERFORMEN
   ============================================================ */
// a) Array von Objekten mit "id" (habits, goals, tasks, persons, notes, ...)
async function listArray<T>(key: string): Promise<T[]> {
  return getBlob<T[]>(key, []);
}
async function mutateArray<T extends { id: string }>(key: string, fn: (list: T[]) => T[]): Promise<T[]> {
  const list = await getBlob<T[]>(key, []);
  const next = fn(list);
  await setBlob(key, next);
  return next;
}

// b) Flache String-Pools (categories, personGroups, noteFolders, financeCategories)
async function listPool(key: string): Promise<string[]> {
  return getBlob<string[]>(key, []);
}
async function addPoolItem(key: string, name: string): Promise<string[]> {
  const list = await getBlob<string[]>(key, []);
  if (!list.includes(name)) list.push(name);
  await setBlob(key, list);
  return list;
}
async function renamePoolItem(key: string, oldName: string, newName: string): Promise<string[]> {
  const list = await getBlob<string[]>(key, []);
  const idx = list.indexOf(oldName);
  if (idx === -1) throw new Error(`"${oldName}" wurde in ${key} nicht gefunden.`);
  list[idx] = newName;
  await setBlob(key, list);
  return list;
}
async function removePoolItem(key: string, name: string): Promise<string[]> {
  const list = (await getBlob<string[]>(key, [])).filter((x) => x !== name);
  await setBlob(key, list);
  return list;
}

// c) Datums-geschlüsselte Objekte (entries, journal, moods)
async function getDateMap<T>(key: string): Promise<Record<string, T>> {
  return getBlob<Record<string, T>>(key, {});
}
async function setDateEntry<T>(key: string, date: string, value: T | null): Promise<Record<string, T>> {
  const map = await getBlob<Record<string, T>>(key, {});
  if (value === null) delete map[date];
  else map[date] = value;
  await setBlob(key, map);
  return map;
}
function filterDateRange<T>(map: Record<string, T>, startDate?: string, endDate?: string): Record<string, T> {
  if (!startDate && !endDate) return map;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) {
    if (startDate && k < startDate) continue;
    if (endDate && k > endDate) continue;
    out[k] = v;
  }
  return out;
}

/* ============================================================
   MCP-TOOL-DEFINITIONEN
   ============================================================ */
type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<unknown>;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const arr = (items: unknown, description: string) => ({ type: "array", items, description });

const TOOLS: ToolDef[] = [];
function tool(name: string, description: string, inputSchema: Record<string, unknown>, handler: ToolDef["handler"]) {
  TOOLS.push({ name, description, inputSchema, handler });
}

/* ---------- Habits + Entries (los-habits, los-entries) ---------- */
tool("list_habits", "Listet alle Habits (Gewohnheiten) auf.", obj({}), async () => listArray("los-habits"));

tool("create_habit", "Legt ein neues Habit an.", obj({
  name: str("Name des Habits"),
  description: str("Beschreibung"),
  color: str("Hex-Farbe, z.B. #FF7A45"),
  icon: str("Icon-Key"),
  category: str("Kategorie (siehe list_categories)"),
  difficulty: { type: "string", enum: ["leicht", "mittel", "schwer"], description: "Schwierigkeit" },
  trackingType: { type: "string", enum: ["boolean", "count", "time", "clock"], description: "Tracking-Art" },
  target: num("Zielwert (bei count/time Zielmenge, bei clock Minuten seit Mitternacht)"),
  unit: str("Einheit, z.B. 'Minuten', 'Seiten'"),
  timeDirection: { type: "string", enum: ["before", "after"], description: "Bei time/clock: 'before' = höchstens/früher als Ziel, 'after' = mindestens/später als Ziel" },
  goalIds: arr({ type: "string" }, "Verknüpfte Ziel-IDs"),
  startDate: str("Startdatum YYYY-MM-DD, Standard: heute"),
}, ["name", "difficulty", "trackingType"]), async (a) => {
  const habit = {
    id: genId("habit"), name: a.name, description: a.description || "", color: a.color || "#FF7A45",
    icon: a.icon || "", category: a.category || "", difficulty: a.difficulty, trackingType: a.trackingType,
    target: a.target ?? 1, unit: a.unit || "", timeDirection: a.timeDirection || "after",
    goalIds: a.goalIds || [], createdAt: today(), startDate: a.startDate || today(),
  };
  return mutateArray("los-habits", (list: any[]) => [...list, habit]);
});

tool("update_habit", "Aktualisiert Felder eines bestehenden Habits.", obj({
  id: str("Habit-ID"), patch: obj({}, []),
}, ["id", "patch"]), async (a) => mutateArray("los-habits", (list: any[]) => {
  const idx = findIndexOrThrow(list, a.id, "Habit");
  list[idx] = { ...list[idx], ...a.patch };
  return list;
}));

tool("delete_habit", "Löscht ein Habit (zugehörige Entries bleiben unangetastet).", obj({ id: str("Habit-ID") }, ["id"]),
  async (a) => mutateArray("los-habits", (list: any[]) => list.filter((h) => h.id !== a.id)));

tool("log_habit_entry", "Trägt den Wert eines Habits für ein Datum ein (abhaken/Wert setzen). value: true/false bei boolean, Zahl bei count/time/clock, \"skip\" für übersprungene Tage (z.B. Urlaub), null löscht den Eintrag (= offen).", obj({
  habitId: str("Habit-ID"), date: str("YYYY-MM-DD, Standard: heute"),
  value: { description: "true/false, Zahl, \"skip\" oder null" },
}, ["habitId", "value"]), async (a) => {
  const date = a.date || today();
  const entries = await getBlob<Record<string, Record<string, unknown>>>("los-entries", {});
  const day = { ...(entries[date] || {}) };
  if (a.value === null) delete day[a.habitId]; else day[a.habitId] = a.value;
  entries[date] = day;
  await setBlob("los-entries", entries);
  return { date, habitId: a.habitId, value: a.value ?? null };
});

tool("get_habit_entries", "Liest alle Einträge eines Habits in einem Datumsbereich.", obj({
  habitId: str("Habit-ID"), startDate: str("YYYY-MM-DD"), endDate: str("YYYY-MM-DD"),
}, ["habitId"]), async (a) => {
  const entries = await getDateMap<Record<string, unknown>>("los-entries");
  const ranged = filterDateRange(entries, a.startDate, a.endDate);
  const out: Record<string, unknown> = {};
  for (const [date, day] of Object.entries(ranged)) if (a.habitId in day) out[date] = day[a.habitId];
  return out;
});

tool("get_entries_for_date", "Liest die Einträge aller Habits für ein Datum.", obj({ date: str("YYYY-MM-DD, Standard: heute") }, []),
  async (a) => (await getDateMap<Record<string, unknown>>("los-entries"))[a.date || today()] || {});

/* ---------- Achievements (los-achievements) — nur lesend ---------- */
tool("list_achievements", "Listet erzielte Erfolge auf (werden automatisch von der App vergeben, nicht manuell editierbar).", obj({}),
  async () => listArray("los-achievements"));

/* ---------- Journal (los-journal) ---------- */
tool("get_journal_entry", "Liest den Journal-Eintrag eines Datums.", obj({ date: str("YYYY-MM-DD, Standard: heute") }, []),
  async (a) => (await getDateMap("los-journal"))[a.date || today()] ?? null);

tool("list_journal_entries", "Listet Journal-Einträge in einem Datumsbereich.", obj({ startDate: str("YYYY-MM-DD"), endDate: str("YYYY-MM-DD") }, []),
  async (a) => filterDateRange(await getDateMap("los-journal"), a.startDate, a.endDate));

tool("set_journal_entry", "Schreibt/überschreibt den Journal-Eintrag eines Datums.", obj({
  date: str("YYYY-MM-DD, Standard: heute"), text: str("Freitext (darf HTML enthalten)"), feedback: str("Optionales KI-Feedback"),
}, ["text"]), async (a) => setDateEntry("los-journal", a.date || today(), { text: a.text, ...(a.feedback !== undefined ? { feedback: a.feedback } : {}) }));

tool("delete_journal_entry", "Löscht den Journal-Eintrag eines Datums.", obj({ date: str("YYYY-MM-DD") }, ["date"]),
  async (a) => setDateEntry("los-journal", a.date, null));

/* ---------- Goals (los-goals) ---------- */
tool("list_goals", "Listet alle Ziele auf.", obj({}), async () => listArray("los-goals"));

tool("create_goal", "Legt ein neues Ziel an.", obj({
  title: str("Titel"), description: str("Beschreibung"), category: str("Kategorie"), points: num("Punktwert"),
}, ["title"]), async (a) => mutateArray("los-goals", (list: any[]) => [...list, {
  id: genId("goal"), title: a.title, description: a.description || "", category: a.category || "",
  points: a.points ?? 0, achieved: false, achievedAt: null, createdAt: today(),
}]));

tool("update_goal", "Aktualisiert Felder eines Ziels.", obj({ id: str("Ziel-ID"), patch: obj({}, []) }, ["id", "patch"]),
  async (a) => mutateArray("los-goals", (list: any[]) => { const i = findIndexOrThrow(list, a.id, "Ziel"); list[i] = { ...list[i], ...a.patch }; return list; }));

tool("set_goal_achieved", "Markiert ein Ziel als erreicht/nicht erreicht.", obj({
  id: str("Ziel-ID"), achieved: bool("true = erreicht"), achievedAt: str("YYYY-MM-DD, Standard: heute"),
}, ["id", "achieved"]), async (a) => mutateArray("los-goals", (list: any[]) => {
  const i = findIndexOrThrow(list, a.id, "Ziel");
  list[i] = { ...list[i], achieved: a.achieved, achievedAt: a.achieved ? (a.achievedAt || today()) : null };
  return list;
}));

tool("delete_goal", "Löscht ein Ziel.", obj({ id: str("Ziel-ID") }, ["id"]),
  async (a) => mutateArray("los-goals", (list: any[]) => list.filter((g) => g.id !== a.id)));

/* ---------- Tasks (los-tasks) ---------- */
tool("list_tasks", "Listet Aufgaben auf.", obj({ includeCompleted: bool("Erledigte mit anzeigen, Standard true") }, []),
  async (a) => { const list = await listArray<any>("los-tasks"); return a.includeCompleted === false ? list.filter((t) => !t.completed) : list; });

tool("create_task", "Legt eine neue Aufgabe an.", obj({
  title: str("Titel"), content: str("Beschreibung"), category: str("Kategorie"), points: num("Punktwert"), dueDate: str("Fälligkeitsdatum YYYY-MM-DD"),
}, ["title"]), async (a) => mutateArray("los-tasks", (list: any[]) => [...list, {
  id: genId("task"), title: a.title, content: a.content || "", category: a.category || "", points: a.points ?? 0,
  dueDate: a.dueDate || null, completed: false, completedAt: null, createdAt: today(),
}]));

tool("update_task", "Aktualisiert Felder einer Aufgabe.", obj({ id: str("Task-ID"), patch: obj({}, []) }, ["id", "patch"]),
  async (a) => mutateArray("los-tasks", (list: any[]) => { const i = findIndexOrThrow(list, a.id, "Aufgabe"); list[i] = { ...list[i], ...a.patch }; return list; }));

tool("set_task_completed", "Markiert eine Aufgabe als erledigt/offen.", obj({ id: str("Task-ID"), completed: bool("true = erledigt") }, ["id", "completed"]),
  async (a) => mutateArray("los-tasks", (list: any[]) => {
    const i = findIndexOrThrow(list, a.id, "Aufgabe");
    list[i] = { ...list[i], completed: a.completed, completedAt: a.completed ? today() : null };
    return list;
  }));

tool("delete_task", "Löscht eine Aufgabe.", obj({ id: str("Task-ID") }, ["id"]),
  async (a) => mutateArray("los-tasks", (list: any[]) => list.filter((t) => t.id !== a.id)));

/* ---------- Persons (los-persons) inkl. Treffen, Leihen, Beziehungen ---------- */
tool("list_persons", "Listet alle Personen auf.", obj({}), async () => listArray("los-persons"));
tool("get_person", "Liest eine einzelne Person.", obj({ id: str("Personen-ID") }, ["id"]),
  async (a) => { const list = await listArray<any>("los-persons"); const p = list.find((x) => x.id === a.id); if (!p) throw new Error(`Person mit id "${a.id}" wurde nicht gefunden.`); return p; });

tool("create_person", "Legt eine neue Person an.", obj({
  name: str("Name"), info: str("Notiz/Info"), groups: arr({ type: "string" }, "Gruppen (siehe list_person_groups)"),
  birthday: str("Geburtstag YYYY-MM-DD"), birthdayYearConfirmed: bool("Ob das Geburtsjahr bekannt/bestätigt ist"),
  color: str("Hex-Farbe"), meetingTrackingEnabled: bool("Ob Treffen für diese Person getrackt werden, Standard true"),
}, ["name"]), async (a) => mutateArray("los-persons", (list: any[]) => [...list, {
  id: genId("person"), name: a.name, info: a.info || "", groups: a.groups || [], category: (a.groups || [])[0] || "",
  birthday: a.birthday || null, birthdayYearConfirmed: a.birthdayYearConfirmed ?? false, color: a.color || "#9B8CFF",
  meetingTrackingEnabled: a.meetingTrackingEnabled ?? true, meetings: [], loans: [], relationships: [],
  dismissedRelationshipSuggestions: [], createdAt: today(),
}]));

tool("update_person", "Aktualisiert Stammdaten-Felder einer Person (nicht meetings/loans/relationships - dafür die eigenen Tools nutzen).", obj({
  id: str("Personen-ID"), patch: obj({}, []),
}, ["id", "patch"]), async (a) => mutateArray("los-persons", (list: any[]) => { const i = findIndexOrThrow(list, a.id, "Person"); list[i] = { ...list[i], ...a.patch }; return list; }));

tool("delete_person", "Löscht eine Person (entfernt auch Beziehungs-Verweise bei anderen Personen).", obj({ id: str("Personen-ID") }, ["id"]),
  async (a) => mutateArray("los-persons", (list: any[]) => list
    .filter((p) => p.id !== a.id)
    .map((p) => ({ ...p, relationships: (p.relationships || []).filter((r: any) => r.personId !== a.id) }))));

tool("log_meeting", "Trägt ein Treffen mit einer Person ein (Datum wird der meetings-Liste hinzugefügt).", obj({
  personId: str("Personen-ID"), date: str("YYYY-MM-DD, Standard: heute"),
}, ["personId"]), async (a) => mutateArray("los-persons", (list: any[]) => {
  const i = findIndexOrThrow(list, a.personId, "Person");
  list[i] = { ...list[i], meetings: [...(list[i].meetings || []), a.date || today()] };
  return list;
}));

tool("remove_meeting", "Entfernt ein eingetragenes Treffen (ein Vorkommen des Datums) einer Person.", obj({
  personId: str("Personen-ID"), date: str("YYYY-MM-DD"),
}, ["personId", "date"]), async (a) => mutateArray("los-persons", (list: any[]) => {
  const i = findIndexOrThrow(list, a.personId, "Person");
  const meetings = [...(list[i].meetings || [])];
  const idx = meetings.indexOf(a.date);
  if (idx === -1) throw new Error(`Kein Treffen am ${a.date} für diese Person gefunden.`);
  meetings.splice(idx, 1);
  list[i] = { ...list[i], meetings };
  return list;
}));

tool("add_loan", "Trägt eine Leihe/Schuld mit einer Person ein.", obj({
  personId: str("Personen-ID"), amount: num("Betrag"), direction: { type: "string", enum: ["lent", "borrowed"], description: "lent = ich habe verliehen, borrowed = ich habe mir geliehen" },
  note: str("Notiz"), date: str("YYYY-MM-DD, Standard: heute"),
}, ["personId", "amount", "direction"]), async (a) => mutateArray("los-persons", (list: any[]) => {
  const i = findIndexOrThrow(list, a.personId, "Person");
  const loan = { id: genId("loan"), amount: a.amount, direction: a.direction, note: a.note || "", date: a.date || today(), settled: false, settledAt: null, createdAt: today() };
  list[i] = { ...list[i], loans: [...(list[i].loans || []), loan] };
  return list;
}));

tool("settle_loan", "Markiert eine Leihe als begleichen/offen.", obj({
  personId: str("Personen-ID"), loanId: str("Loan-ID"), settled: bool("true = begleichen"),
}, ["personId", "loanId", "settled"]), async (a) => mutateArray("los-persons", (list: any[]) => {
  const i = findIndexOrThrow(list, a.personId, "Person");
  const loans = [...(list[i].loans || [])];
  const li = findIndexOrThrow(loans, a.loanId, "Leihe");
  loans[li] = { ...loans[li], settled: a.settled, settledAt: a.settled ? today() : null };
  list[i] = { ...list[i], loans };
  return list;
}));

tool("delete_loan", "Löscht eine Leihe.", obj({ personId: str("Personen-ID"), loanId: str("Loan-ID") }, ["personId", "loanId"]),
  async (a) => mutateArray("los-persons", (list: any[]) => {
    const i = findIndexOrThrow(list, a.personId, "Person");
    list[i] = { ...list[i], loans: (list[i].loans || []).filter((l: any) => l.id !== a.loanId) };
    return list;
  }));

tool("set_relationship", "Setzt eine Beziehung zwischen zwei Personen (spiegelt automatisch die Gegenrichtung, z.B. parent<->child).", obj({
  personId: str("Personen-ID"), otherPersonId: str("ID der anderen Person"),
  type: { type: "string", enum: Object.keys(INVERSE_RELATIONSHIP), description: "Beziehungstyp aus Sicht von personId" },
}, ["personId", "otherPersonId", "type"]), async (a) => mutateArray("los-persons", (list: any[]) => {
  const i = findIndexOrThrow(list, a.personId, "Person");
  const j = findIndexOrThrow(list, a.otherPersonId, "Andere Person");
  const setRel = (idx: number, otherId: string, type: string) => {
    const rels = (list[idx].relationships || []).filter((r: any) => r.personId !== otherId);
    rels.push({ personId: otherId, type });
    list[idx] = { ...list[idx], relationships: rels };
  };
  setRel(i, a.otherPersonId, a.type);
  setRel(j, a.personId, INVERSE_RELATIONSHIP[a.type]);
  return list;
}));

tool("remove_relationship", "Entfernt eine Beziehung zwischen zwei Personen (beidseitig).", obj({
  personId: str("Personen-ID"), otherPersonId: str("ID der anderen Person"),
}, ["personId", "otherPersonId"]), async (a) => mutateArray("los-persons", (list: any[]) => {
  const i = findIndexOrThrow(list, a.personId, "Person");
  const j = findIndexOrThrow(list, a.otherPersonId, "Andere Person");
  list[i] = { ...list[i], relationships: (list[i].relationships || []).filter((r: any) => r.personId !== a.otherPersonId) };
  list[j] = { ...list[j], relationships: (list[j].relationships || []).filter((r: any) => r.personId !== a.personId) };
  return list;
}));

/* ---------- Kategorien / Personen-Gruppen (Pools) ---------- */
tool("list_categories", "Listet den gemeinsamen Kategorie-Pool (für Habits/Ziele/Aufgaben) auf.", obj({}), async () => listPool("los-categories"));
tool("add_category", "Fügt eine Kategorie hinzu.", obj({ name: str("Name") }, ["name"]), async (a) => addPoolItem("los-categories", a.name));
tool("rename_category", "Benennt eine Kategorie um.", obj({ oldName: str("Alter Name"), newName: str("Neuer Name") }, ["oldName", "newName"]),
  async (a) => renamePoolItem("los-categories", a.oldName, a.newName));
tool("remove_category", "Entfernt eine Kategorie aus dem Pool.", obj({ name: str("Name") }, ["name"]), async (a) => removePoolItem("los-categories", a.name));

tool("list_person_groups", "Listet den Gruppen-Pool für Personen auf.", obj({}), async () => listPool("los-person-groups"));
tool("add_person_group", "Fügt eine Personen-Gruppe hinzu.", obj({ name: str("Name") }, ["name"]), async (a) => addPoolItem("los-person-groups", a.name));
tool("rename_person_group", "Benennt eine Personen-Gruppe um.", obj({ oldName: str("Alter Name"), newName: str("Neuer Name") }, ["oldName", "newName"]),
  async (a) => renamePoolItem("los-person-groups", a.oldName, a.newName));
tool("remove_person_group", "Entfernt eine Personen-Gruppe.", obj({ name: str("Name") }, ["name"]), async (a) => removePoolItem("los-person-groups", a.name));

/* ---------- Moods (los-moods) ---------- */
tool("get_mood", "Liest den Mood-Eintrag eines Datums.", obj({ date: str("YYYY-MM-DD, Standard: heute") }, []),
  async (a) => (await getDateMap("los-moods"))[a.date || today()] ?? null);
tool("list_moods", "Listet Mood-Einträge in einem Datumsbereich.", obj({ startDate: str("YYYY-MM-DD"), endDate: str("YYYY-MM-DD") }, []),
  async (a) => filterDateRange(await getDateMap("los-moods"), a.startDate, a.endDate));
tool("set_mood", "Schreibt den Mood-Eintrag eines Datums (nicht angegebene Felder bleiben erhalten).", obj({
  date: str("YYYY-MM-DD, Standard: heute"), mentalState: num("Mentaler Zustand 1-5"), mentalEnergy: num("Mentale Energie 1-5"),
  physicalEnergy: num("Körperliche Energie 1-5"), symptoms: arr({ type: "string" }, "Symptome"),
}, []), async (a) => {
  const date = a.date || today();
  const map = await getDateMap<any>("los-moods");
  const existing = map[date] || {};
  const next = { ...existing };
  for (const f of ["mentalState", "mentalEnergy", "physicalEnergy", "symptoms"]) if (a[f] !== undefined) next[f] = a[f];
  return setDateEntry("los-moods", date, next);
});
tool("delete_mood", "Löscht den Mood-Eintrag eines Datums.", obj({ date: str("YYYY-MM-DD") }, ["date"]), async (a) => setDateEntry("los-moods", a.date, null));

/* ---------- Verbrauchsmaterial (los-consumables: Bereiche mit Artikeln) ---------- */
tool("list_consumable_areas", "Listet alle Verbrauchsmaterial-Bereiche mit ihren Artikeln auf.", obj({}), async () => listArray("los-consumables"));

tool("create_consumable_area", "Legt einen neuen Verbrauchsmaterial-Bereich an.", obj({ name: str("Name") }, ["name"]),
  async (a) => mutateArray("los-consumables", (list: any[]) => [...list, { id: genId("area"), name: a.name, items: [], createdAt: today() }]));

tool("delete_consumable_area", "Löscht einen Verbrauchsmaterial-Bereich inkl. aller Artikel.", obj({ id: str("Bereichs-ID") }, ["id"]),
  async (a) => mutateArray("los-consumables", (list: any[]) => list.filter((area) => area.id !== a.id)));

tool("add_consumable_item", "Fügt einem Bereich einen Artikel hinzu.", obj({
  areaId: str("Bereichs-ID"), name: str("Artikelname"), available: bool("Vorhanden? Standard true"),
}, ["areaId", "name"]), async (a) => mutateArray("los-consumables", (list: any[]) => {
  const i = findIndexOrThrow(list, a.areaId, "Bereich");
  const available = a.available ?? true;
  const item = { id: genId("consumable"), name: a.name, available, createdAt: today(), history: [{ date: today(), available }] };
  list[i] = { ...list[i], items: [...(list[i].items || []), item] };
  return list;
}));

tool("update_consumable_item", "Aktualisiert einen Artikel (z.B. available umschalten - wird mit Zeitstempel in der history vermerkt).", obj({
  areaId: str("Bereichs-ID"), itemId: str("Artikel-ID"), patch: obj({}, []),
}, ["areaId", "itemId", "patch"]), async (a) => mutateArray("los-consumables", (list: any[]) => {
  const i = findIndexOrThrow(list, a.areaId, "Bereich");
  const items = [...(list[i].items || [])];
  const ii = findIndexOrThrow(items, a.itemId, "Artikel");
  const next = { ...items[ii], ...a.patch };
  if (a.patch.available !== undefined && a.patch.available !== items[ii].available) {
    next.history = [...(items[ii].history || []), { date: today(), available: a.patch.available }];
  }
  items[ii] = next;
  list[i] = { ...list[i], items };
  return list;
}));

tool("delete_consumable_item", "Löscht einen Artikel aus einem Bereich.", obj({ areaId: str("Bereichs-ID"), itemId: str("Artikel-ID") }, ["areaId", "itemId"]),
  async (a) => mutateArray("los-consumables", (list: any[]) => {
    const i = findIndexOrThrow(list, a.areaId, "Bereich");
    list[i] = { ...list[i], items: (list[i].items || []).filter((it: any) => it.id !== a.itemId) };
    return list;
  }));

/* ---------- Einkaufsliste (los-shopping-list) ---------- */
tool("list_shopping_list", "Listet die Einkaufsliste auf.", obj({ includeCompleted: bool("Erledigte mit anzeigen, Standard true") }, []),
  async (a) => { const list = await listArray<any>("los-shopping-list"); return a.includeCompleted === false ? list.filter((x) => !x.completed) : list; });

tool("add_shopping_item", "Fügt einen Eintrag zur Einkaufsliste hinzu.", obj({
  name: str("Name"), areaName: str("Zugehöriger Verbrauchsmaterial-Bereich (optional)"), sourceConsumableId: str("Verknüpfte Artikel-ID (optional)"),
}, ["name"]), async (a) => mutateArray("los-shopping-list", (list: any[]) => [...list, {
  id: genId("shopping"), name: a.name, areaName: a.areaName || null, completed: false, completedAt: null,
  createdAt: today(), sourceConsumableId: a.sourceConsumableId || null,
}]));

tool("set_shopping_item_completed", "Markiert einen Einkaufslisten-Eintrag als erledigt/offen.", obj({ id: str("Eintrags-ID"), completed: bool("true = erledigt") }, ["id", "completed"]),
  async (a) => mutateArray("los-shopping-list", (list: any[]) => {
    const i = findIndexOrThrow(list, a.id, "Einkaufslisten-Eintrag");
    list[i] = { ...list[i], completed: a.completed, completedAt: a.completed ? today() : null };
    return list;
  }));

tool("delete_shopping_item", "Löscht einen Einkaufslisten-Eintrag.", obj({ id: str("Eintrags-ID") }, ["id"]),
  async (a) => mutateArray("los-shopping-list", (list: any[]) => list.filter((x) => x.id !== a.id)));

/* ---------- Notizen + Ordner (los-notes, los-note-folders) ---------- */
tool("list_notes", "Listet Notizen auf, optional gefiltert nach Ordner.", obj({ folder: str("Ordnername (optional)") }, []),
  async (a) => { const list = await listArray<any>("los-notes"); return a.folder ? list.filter((n) => n.folder === a.folder) : list; });

tool("get_note", "Liest eine einzelne Notiz.", obj({ id: str("Notiz-ID") }, ["id"]),
  async (a) => { const list = await listArray<any>("los-notes"); const n = list.find((x) => x.id === a.id); if (!n) throw new Error(`Notiz mit id "${a.id}" wurde nicht gefunden.`); return n; });

tool("create_note", "Legt eine neue Notiz an.", obj({ title: str("Titel"), folder: str("Ordner"), content: str("Inhalt (darf HTML enthalten)") }, ["title"]),
  async (a) => mutateArray("los-notes", (list: any[]) => [...list, { id: genId("note"), title: a.title, folder: a.folder || "", content: a.content || "", createdAt: nowIso(), updatedAt: nowIso() }]));

tool("update_note", "Aktualisiert Felder einer Notiz (aktualisiert updatedAt).", obj({ id: str("Notiz-ID"), patch: obj({}, []) }, ["id", "patch"]),
  async (a) => mutateArray("los-notes", (list: any[]) => { const i = findIndexOrThrow(list, a.id, "Notiz"); list[i] = { ...list[i], ...a.patch, updatedAt: nowIso() }; return list; }));

tool("delete_note", "Löscht eine Notiz.", obj({ id: str("Notiz-ID") }, ["id"]), async (a) => mutateArray("los-notes", (list: any[]) => list.filter((n) => n.id !== a.id)));

tool("list_note_folders", "Listet die Notiz-Ordner auf.", obj({}), async () => listPool("los-note-folders"));
tool("add_note_folder", "Fügt einen Notiz-Ordner hinzu.", obj({ name: str("Name") }, ["name"]), async (a) => addPoolItem("los-note-folders", a.name));
tool("rename_note_folder", "Benennt einen Notiz-Ordner um.", obj({ oldName: str("Alter Name"), newName: str("Neuer Name") }, ["oldName", "newName"]),
  async (a) => renamePoolItem("los-note-folders", a.oldName, a.newName));
tool("remove_note_folder", "Entfernt einen Notiz-Ordner.", obj({ name: str("Name") }, ["name"]), async (a) => removePoolItem("los-note-folders", a.name));

/* ---------- Finanzen (los-finance-entries, los-finance-categories) ---------- */
tool("list_finance_entries", "Listet Finanzbuchungen auf, optional gefiltert.", obj({
  startDate: str("YYYY-MM-DD"), endDate: str("YYYY-MM-DD"), type: { type: "string", enum: ["expense", "income", "investment"] }, category: str("Kategorie"),
}, []), async (a) => {
  let list = await listArray<any>("los-finance-entries");
  if (a.startDate) list = list.filter((e) => e.date >= a.startDate);
  if (a.endDate) list = list.filter((e) => e.date <= a.endDate);
  if (a.type) list = list.filter((e) => e.type === a.type);
  if (a.category) list = list.filter((e) => e.category === a.category);
  return list;
});

tool("create_finance_entry", "Legt eine neue Finanzbuchung an.", obj({
  type: { type: "string", enum: ["expense", "income", "investment"], description: "Buchungsart" },
  amount: num("Betrag"), category: str("Kategorie/Bereich"), fixed: bool("Fixkosten? Standard false"),
  coverageMonths: arr({ type: "string" }, "Bei fixed: abgedeckte Monate YYYY-MM"),
  marie: bool("50/50-Split-Markierung"), note: str("Notiz"), date: str("YYYY-MM-DD, Standard: heute"),
  linkId: str("Freie Verknüpfungs-ID, z.B. um Ausgabe+Einnahme zu koppeln"),
}, ["type", "amount", "category"]), async (a) => mutateArray("los-finance-entries", (list: any[]) => [...list, {
  id: genId("fin"), type: a.type, amount: a.amount, category: a.category, fixed: a.fixed ?? false,
  coverageMonths: a.coverageMonths || [], marie: a.marie ?? false, note: a.note || "", date: a.date || today(),
  linkId: a.linkId || genId("link"), createdAt: today(),
}]));

tool("update_finance_entry", "Aktualisiert Felder einer Finanzbuchung.", obj({ id: str("Buchungs-ID"), patch: obj({}, []) }, ["id", "patch"]),
  async (a) => mutateArray("los-finance-entries", (list: any[]) => { const i = findIndexOrThrow(list, a.id, "Finanzbuchung"); list[i] = { ...list[i], ...a.patch }; return list; }));

tool("delete_finance_entry", "Löscht eine Finanzbuchung.", obj({ id: str("Buchungs-ID") }, ["id"]),
  async (a) => mutateArray("los-finance-entries", (list: any[]) => list.filter((e) => e.id !== a.id)));

tool("list_finance_categories", "Listet die Finanz-Kategorien (Bereiche) auf.", obj({}), async () => listPool("los-finance-categories"));
tool("add_finance_category", "Fügt eine Finanz-Kategorie hinzu.", obj({ name: str("Name") }, ["name"]), async (a) => addPoolItem("los-finance-categories", a.name));
tool("rename_finance_category", "Benennt eine Finanz-Kategorie um.", obj({ oldName: str("Alter Name"), newName: str("Neuer Name") }, ["oldName", "newName"]),
  async (a) => renamePoolItem("los-finance-categories", a.oldName, a.newName));
tool("remove_finance_category", "Entfernt eine Finanz-Kategorie.", obj({ name: str("Name") }, ["name"]), async (a) => removePoolItem("los-finance-categories", a.name));

/* ---------- Dashboard-Widgets (los-dashboard-widgets) ---------- */
tool("get_dashboard_widgets", "Liest die Konfiguration des 'Mein Dashboard'-Widgets.", obj({}), async () => getBlob("los-dashboard-widgets", null));

tool("update_dashboard_widgets", "Aktualisiert die Dashboard-Widget-Konfiguration (merge auf oberster Ebene).", obj({
  enabled: arr({ type: "string" }, "Aktivierte Widget-IDs in Anzeigereihenfolge"),
  ranges: obj({}, []),
}, []), async (a) => {
  const current = (await getBlob<any>("los-dashboard-widgets", { enabled: [], ranges: {} })) || { enabled: [], ranges: {} };
  const next = { ...current, ...(a.enabled !== undefined ? { enabled: a.enabled } : {}), ...(a.ranges !== undefined ? { ranges: { ...current.ranges, ...a.ranges } } : {}) };
  await setBlob("los-dashboard-widgets", next);
  return next;
});

/* ============================================================
   JSON-RPC / MCP-STREAMABLE-HTTP — minimaler, zustandsloser Server
   (kein SDK-HTTP-Transport, da dieser auf Node-Request/Response statt
   die Fetch-API von Deno Edge Functions ausgelegt ist)
   ============================================================ */
const PROTOCOL_VERSION_FALLBACK = "2025-06-18";

async function handleSingleMessage(msg: any): Promise<any | null> {
  const isNotification = msg.id === undefined;
  try {
    if (msg.method === "initialize") {
      const result = {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "lifetracker", version: "1.0.0" },
      };
      return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
    }
    if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return null;
    if (msg.method === "ping") return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result: {} };
    if (msg.method === "tools/list") {
      const result = { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const def = TOOLS.find((t) => t.name === name);
      if (!def) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unbekanntes Tool: ${name}` } };
      try {
        const data = await def.handler(msg.params?.arguments || {});
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] } };
      } catch (err) {
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Fehler: ${(err as Error).message}` }], isError: true } };
      }
    }
    return isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unbekannte Methode: ${msg.method}` } };
  } catch (err) {
    return isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (err as Error).message } };
  }
}

async function handleRpc(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map(handleSingleMessage))).filter((r) => r !== null);
  if (responses.length === 0) return new Response(null, { status: 202 });
  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function isAuthorized(req: Request): boolean {
  if (!MCP_SECRET_TOKEN) return false;
  const auth = req.headers.get("authorization") || "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearerMatch && bearerMatch[1] === MCP_SECRET_TOKEN) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("token") === MCP_SECRET_TOKEN) return true;
  return url.pathname.endsWith(`/${MCP_SECRET_TOKEN}`);
}

Deno.serve(async (req) => {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
      status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }
  if (req.method === "POST") return handleRpc(req);
  return new Response("Method Not Allowed", { status: 405 });
});
