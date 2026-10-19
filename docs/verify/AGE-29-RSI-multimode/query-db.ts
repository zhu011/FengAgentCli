import { Database } from "bun:sqlite";
const db = new Database(".verify-rsi/data/reflect/reflections.db", { readonly: true });
const cards = db.query("SELECT id, revision, status, trigger, lesson, effect_json, updated_at FROM reflections").all() as any[];
console.log("== reflections ==");
for (const c of cards) console.log(JSON.stringify({ id: String(c.id).slice(0, 8), rev: c.revision, status: c.status, trigger: c.trigger, lesson: String(c.lesson).slice(0, 60), effect: String(c.effect_json).slice(0, 120) }));
const events = db.query("SELECT seq, type, payload FROM reflection_events ORDER BY seq").all() as any[];
console.log("== reflection_events (" + events.length + ") ==");
for (const e of events) {
  const p = JSON.parse(e.payload || "{}");
  console.log(e.seq, e.type, "sid=" + String(p.sessionId ?? "-").slice(0, 8), "cards=" + JSON.stringify((p.cardIds ?? []).map((x: string) => x.slice(0, 8))));
}
