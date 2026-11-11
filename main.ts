import { createHash } from "node:crypto";

type View = any;
type Pending = { game: number; decision: string; options?: number[]; view: View };

const base = process.env.MAKEFUN_ENV_URL;
const seed = process.env.MAKEFUN_TRIAL_SEED || "";
if (!base) throw new Error("MAKEFUN_ENV_URL is required");

function hashInt(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32BE(0);
}
function choose<T>(xs: T[], key: string): T | undefined {
  if (!xs.length) return undefined;
  return xs[hashInt(seed + "|" + key) % xs.length];
}
function living(view: View): number[] {
  return view.players.filter((p: any) => p.alive).map((p: any) => p.seat);
}
function analyze(view: View): { score: number[]; wolves: number[]; claims: any[]; checks: any[] } {
  const me = view.you.seat;
  const score = Array(9).fill(0);
  const checks: any[] = [];
  for (const p of view.players) if (!p.alive && p.role === "werewolf") score[p.seat] = -100;
  for (const r of view.seerResults || []) {
    checks.push(r);
    if (r.werewolf) score[r.seat] = 100;
    else score[r.seat] = -100;
  }
  const speeches = view.log.filter((e: any) => e.kind === "speech");
  const claims: any[] = [];
  for (const e of speeches) {
    const t = e.text.toLowerCase();
    if (/\b(i am|i'm|as) (the )?seer\b/.test(t) || /\bseer here\b/.test(t)) {
      const c = { seat: e.seat, day: e.day, text: e.text };
      claims.push(c);
      const found = [...e.text.matchAll(/(?:seat\s*)?(\d+)\s+(?:is\s+)?(?:a\s+)?werewolf/ig)];
      for (const m of found) {
        const s = Number(m[1]);
        if (s >= 1 && s <= 8 && s !== e.seat) score[s] += 80;
      }
      const safe = [...e.text.matchAll(/(?:seat\s*)?(\d+)\s+(?:is\s+)?(?:not\s+a\s+werewolf|clear|not wolf)/ig)];
      for (const m of safe) {
        const s = Number(m[1]);
        if (s >= 1 && s <= 8 && s !== e.seat) score[s] -= 25;
      }
    }
    const accusations = [...e.text.matchAll(/(?:seat\s*)?(\d+)(?:\s+is)?\s+(?:a\s+)?(?:wolf|werewolf|sus|suspicious)/ig)];
    for (const m of accusations) {
      const s = Number(m[1]);
      if (s >= 1 && s <= 8 && s !== e.seat) score[s] += 2;
    }
    const defense = [...e.text.matchAll(/(?:defend|trust|clear)\s+(?:seat\s*)?(\d+)/ig)];
    for (const m of defense) {
      const s = Number(m[1]);
      if (s >= 1 && s <= 8 && s !== e.seat) score[s] += 1;
    }
  }
  const exiled = new Map<number, string>();
  for (const e of view.log) if (e.kind === "exile" && e.seat !== null) exiled.set(e.seat, e.role);
  for (const e of view.log) {
    if (e.kind !== "vote" || e.target === null || !exiled.has(e.target)) continue;
    if (exiled.get(e.target) === "werewolf") score[e.seat] -= 4;
    else score[e.seat] += 4;
  }
  for (const c of claims) {
    const counters = claims.filter((x) => x.seat !== c.seat && x.day <= c.day);
    if (!counters.length) score[c.seat] -= 2;
    else score[c.seat] += 1;
  }
  return { score, wolves: score.map((v, i) => v >= 50 ? i : 0).filter(Boolean), claims, checks };
}
function targetFrom(view: View, options: number[], kind: string, info: ReturnType<typeof analyze>): number | null {
  const me = view.you.seat;
  const valid = options.filter((s) => s !== me);
  if (!valid.length) return null;
  if (kind === "kill") {
    const already = (view.wolfVotes || []).find((x: any) => x.night === view.day && x.seat !== me);
    const partner = view.you.partner?.seat;
    if (already && already.target !== null && already.target !== partner && already.target !== me) return already.target;
    const claimed = info.claims.filter((c) => /seer|check|inspected/i.test(c.text));
    const pressured = claimed.find((c) => info.wolves.includes(me) && c.text.includes(String(me)));
    if (pressured && valid.includes(pressured.seat)) return pressured.seat;
    return choose(valid.filter((s) => s !== partner), `${view.you.seat}|${view.day}|kill`) ?? valid[0];
  }
  if (kind === "inspect") {
    const unknown = valid.filter((s) => info.score[s] > -50 && info.score[s] < 50);
    const pool = unknown.length ? unknown : valid;
    return pool.sort((a, b) => (info.score[b] || 0) - (info.score[a] || 0))[0];
  }
  if (kind === "protect") {
    const checks = info.claims.filter((c) => c.seat !== me);
    const visible = checks.find((c) => /seer/i.test(c.text));
    if (visible && valid.includes(visible.seat)) return visible.seat;
    const cleared = valid.filter((s) => info.score[s] < -50);
    const pool = cleared.length ? cleared : valid;
    return choose(pool, `${view.you.seat}|${view.day}|protect`) ?? pool[0];
  }
  return valid.sort((a, b) => (info.score[b] || 0) - (info.score[a] || 0))[0];
}
function speech(view: View, info: ReturnType<typeof analyze>): string {
  const role = view.you.role;
  if (role === "seer") {
    const all = view.seerResults || [];
    const reveal = all.some((r: any) => r.werewolf) || (view.day >= 2 && all.length > 0);
    if (reveal) return `I am the seer. ${all.map((r: any) => `Seat ${r.seat} is ${r.werewolf ? "a werewolf" : "not a werewolf"}.`).join(" ")}`;
  }
  const wolves = info.wolves.filter((s) => living(view).includes(s));
  if (role !== "werewolf" && wolves.length) return `I have a confirmed check on seat ${wolves[0]}; we should vote there.`;
  const ordered = living(view).filter((s) => s !== view.you.seat).sort((a, b) => (info.score[b] || 0) - (info.score[a] || 0));
  if (ordered[0] && (info.score[ordered[0]] || 0) > 0) return `Seat ${ordered[0]} is my concern because their vote pattern looks off.`;
  return choose(["I am watching the votes before settling on a target.", "Let's compare our votes and keep pressure on inconsistent players.", "I have no firm read yet; explain your vote today."], `${view.you.seat}|${view.day}|speech`)!;
}
async function post(path: string, body: any): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: any = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}
async function act(p: Pending): Promise<void> {
  const v = p.view;
  const info = analyze(v);
  let body: any = { game: p.game, decision: p.decision };
  const options = p.options || [];
  if (p.decision === "speak") {
    const text = speech(v, info);
    body.text = [...text].slice(0, 250).join("");
  } else if (p.decision === "vote") {
    const choices = options.filter((s) => s !== v.you.seat);
    const wolf = choices.filter((s) => info.score[s] >= 50).sort((a, b) => info.score[b] - info.score[a])[0];
    const ownConfirmedWolf = v.you.role === "seer"
      ? (v.seerResults || []).find((r: any) => r.werewolf && choices.includes(r.seat))?.seat
      : undefined;
    const claimants = [...new Set(info.claims
      .filter((c) => living(v).includes(c.seat))
      .map((c) => c.seat))];
    const counterclaimPair = claimants.length >= 2
      ? claimants.filter((s) => choices.includes(s))
      : [];
    const currentVotes = v.log.filter((e: any) => e.kind === "vote" && e.day === v.day && e.target !== null);
    const counts = new Map<number, number>();
    for (const vote of currentVotes) counts.set(vote.target, (counts.get(vote.target) || 0) + 1);
    const maxVotes = Math.max(0, ...counts.values());
    const leaders = choices.filter((s) => (counts.get(s) || 0) === maxVotes && maxVotes > 0 && info.score[s] > -50);
    const leading = choose(leaders, `${p.game}|${v.day}|lead|${v.you.seat}`);
    if (v.you.role === "werewolf") {
      const partner = v.you.partner?.seat;
      const partnerAccused = info.wolves.includes(partner);
      const candidates = choices.filter((s) => s !== partner);
      const safeLeaders = leaders.filter((s) => s !== partner);
      body.target = partnerAccused && v.day >= 2 ? partner
        : choose(safeLeaders, `${p.game}|${v.day}|wolflead|${v.you.seat}`)
          ?? (candidates.length ? choose(candidates, `${p.game}|${v.day}|wolfvote|${v.you.seat}`) : null);
    } else body.target = ownConfirmedWolf ?? wolf
      ?? (counterclaimPair.length >= 2
        ? choose(counterclaimPair, `${p.game}|${v.day}|counterclaim|${v.you.seat}`)
        : undefined)
      ?? leading
      ?? (choices.length ? choose(choices.filter((s) => info.score[s] > -50), `${p.game}|${v.day}|villagevote|${v.you.seat}`) ?? choices[0] : null);
  } else body.target = targetFrom(v, options, p.decision, info);
  let result = await post("/act", body);
  if (!result.ok) {
    if (p.decision === "speak") body = { game: p.game, decision: p.decision, pass: true };
    else body = { game: p.game, decision: p.decision, target: options[0] ?? null };
    result = await post("/act", body);
  }
}
while (true) {
  const r = await post("/observe", {});
  if (!r.ok) throw new Error(`observe failed: ${r.status}`);
  const pending: Pending[] = r.data.pending || [];
  if (r.data.done) break;
  await Promise.all(pending.map((p) => act(p)));
}
