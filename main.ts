// werewolf-agent-01: a hand-written, deterministic Werewolf player.
//
// No model calls: every decision is a function of the game's own view alone
// (the brief, the env's views and MAKEFUN_TRIAL_SEED), so the replay, which
// serves the same views back, gets the same answers byte for byte. No wall
// clock, no unseeded randomness, no state shared between games: each pending
// decision is recomputed from that game's view from scratch.
//
// The play, in short:
// - Seer: inspect the most informative seat (a rival claimant first), reveal
//   with the full record the day a living werewolf is known, on day 3 at the
//   latest, or when about to be exiled; then lead the vote every day.
// - Doctor: protect the credible revealed seer, else the likeliest kill.
// - Villager: track every claim, vote record and revealed role; follow a
//   credible seer, expose a proven fake, and vote the best suspicion score.
// - Werewolf: agree with the partner's kill pick (a split kills nobody),
//   hunt the seer and the town's leaders, speak and vote like a villager,
//   bus the partner only when a credible seer has outed them, and fake a
//   seer claim when the real seer is dead and the claim can steer an exile.

import { pathToFileURL } from 'node:url';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  round?: number;
  text?: string;
  target?: Seat | null;
  died?: Seat | null;
  role?: Role | null;
  tally?: { seat: Seat; votes: number }[];
  order?: Seat[];
  winner?: string | null;
  [k: string]: unknown;
}

interface PlayerInfo {
  seat: Seat;
  name: string;
  alive: boolean;
  role: Role | null;
}

interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: Role;
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: PlayerInfo[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

// ---------------------------------------------------------------------------
// Deterministic randomness: a string hash (xmur3-style) feeding mulberry32.
// Every draw is seeded from the trial seed, the game and the view itself, so
// the same view always produces the same decision, in any order, any run.
// ---------------------------------------------------------------------------

function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function rngFor(...parts: (string | number)[]): () => number {
  let a = hashSeed(parts.join('|'));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const trialSeed = (): string => process.env.MAKEFUN_TRIAL_SEED ?? 'makefun';

/** Pick from a non-empty list with the given stream. */
function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
}

/** Weighted pick: highest (weight + noise) wins, so near-ties vary by seed. */
function pickWeighted(rng: () => number, items: readonly Seat[], weight: (s: Seat) => number): Seat {
  let best = items[0]!;
  let bestScore = -Infinity;
  for (const s of items) {
    const score = weight(s) + rng() * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Statement text handling: the env's fold, and this agent's own length cap.
// ---------------------------------------------------------------------------

export function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

function fitStatement(text: string, maxChars: number): string {
  const folded = foldStatement(text);
  const chars = [...folded];
  if (chars.length <= maxChars) return folded;
  return chars.slice(0, maxChars).join('').trim();
}

// ---------------------------------------------------------------------------
// Reading the table: claims, reports and the public record, from the log.
// ---------------------------------------------------------------------------

interface Report {
  by: Seat;
  target: Seat;
  werewolf: boolean;
  day: number;
}

interface ClaimInfo {
  /** Seats that have claimed to be the seer, in the order they claimed. */
  seerClaimants: Seat[];
  /** Seats that have claimed to be the doctor. */
  doctorClaimants: Seat[];
  /** Inspection reports spoken at the table: who said what about whom. */
  reports: Report[];
  /** Soft accusations heard ("seat N is suspicious", "vote seat N"). */
  accusations: Map<Seat, number>;
}

const SEAT_WORD = '(?:seat\\s*)?(\\d{1,2})';

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The polarity of a check report about a seat inside one sentence. */
function reportPolarity(sentence: string): boolean | null {
  const s = sentence.toLowerCase();
  if (/\bnot a (werewolf|wolf)\b|\bisn'?t a (werewolf|wolf)\b|\bnot (a )?wolf\b|\bno wolf\b/.test(s)) return false;
  if (/\bclean\b|\binnocent\b|\bvillage\b|\bhuman\b|\btown\b/.test(s) && !/\bwerewolf\b/.test(s.replace(/\bnot a werewolf\b/g, ''))) return false;
  if (/\bwerewolf\b|\ba wolf\b|\bwolf\b/.test(s)) return true;
  if (/\bclean\b|\binnocent\b|\bvillage\b|\bhuman\b/.test(s)) return false;
  return null;
}

function parseClaims(view: View): ClaimInfo {
  const info: ClaimInfo = { seerClaimants: [], doctorClaimants: [], reports: [], accusations: new Map() };
  const me = view.you.seat;
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || e.seat === undefined) continue;
    const speaker = e.seat;
    const text = e.text;
    const lower = text.toLowerCase();
    if (speaker !== me) {
      if (/\bi(?:'m| am) (?:the )?seer\b|\bi claim (?:to be )?(?:the )?seer\b|\bseer here\b|\bas (?:the|your) seer\b|\bi was the seer\b/.test(lower)) {
        if (!info.seerClaimants.includes(speaker)) info.seerClaimants.push(speaker);
      }
      if (/\bi(?:'m| am) (?:the )?doctor\b|\bi claim (?:to be )?(?:the )?doctor\b|\bdoctor here\b/.test(lower)) {
        if (!info.doctorClaimants.includes(speaker)) info.doctorClaimants.push(speaker);
      }
    }
    for (const sentence of sentences(text)) {
      const s = sentence.toLowerCase();
      const checkVerb = /\b(?:checked|inspected|visited|scanned|looked at|saw)\b/.test(s);
      const seatNums = [...s.matchAll(/(?:seat\s*)?(\d{1,2})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= 8);
      if (checkVerb || /\bmy (?:check|inspection|result)\b/.test(s) || info.seerClaimants.includes(speaker)) {
        const polarity = reportPolarity(s);
        if (polarity !== null) {
          for (const target of seatNums) {
            if (target !== speaker && !info.reports.some((r) => r.by === speaker && r.target === target)) {
              info.reports.push({ by: speaker, target, werewolf: polarity, day: e.day });
            }
          }
        }
      }
      const accuse = new RegExp(`\\b${SEAT_WORD}\\b[^.!?]*\\b(?:is suspicious|seems off|feels off|is acting|must be|looks like)`, 'i');
      const am = accuse.exec(sentence);
      if (am) {
        const t = Number(am[1]);
        if (t !== speaker) info.accusations.set(t, (info.accusations.get(t) ?? 0) + 1);
      }
      const voteFor = new RegExp(`\\bvote (?:for )?(?:seat\\s*)?(\\d{1,2})\\b`, 'i');
      const vm = voteFor.exec(sentence);
      if (vm) {
        const t = Number(vm[1]);
        if (t !== speaker) info.accusations.set(t, (info.accusations.get(t) ?? 0) + 0.5);
      }
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// The reconstructed state of one game, from one view.
// ---------------------------------------------------------------------------

interface GameState {
  view: View;
  me: Seat;
  myRole: Role;
  claims: ClaimInfo;
  /** Revealed roles of the dead (and of anyone whose role is public). */
  revealed: Map<Seat, Role>;
  /** Votes by day: day -> [{seat, target}] in cast order. */
  votesByDay: Map<number, { seat: Seat; target: Seat | null }[]>;
  /** Who died at each dawn: day -> seat or null. */
  dawnDeaths: Map<number, Seat | null>;
  /** Speeches by seat: how much each seat has said, and when they last spoke. */
  speechCount: Map<Seat, number>;
  /** The exile of each day: day -> seat or null. */
  exiles: Map<number, Seat | null>;
}

function buildState(view: View): GameState {
  const st: GameState = {
    view,
    me: view.you.seat,
    myRole: view.you.role,
    claims: parseClaims(view),
    revealed: new Map(),
    votesByDay: new Map(),
    dawnDeaths: new Map(),
    speechCount: new Map(),
    exiles: new Map(),
  };
  for (const p of view.players) if (p.role !== null) st.revealed.set(p.seat, p.role);
  for (const e of view.log) {
    if (e.kind === 'dawn') st.dawnDeaths.set(e.day, e.died ?? null);
    else if (e.kind === 'speech' && e.seat !== undefined) st.speechCount.set(e.seat, (st.speechCount.get(e.seat) ?? 0) + 1);
    else if (e.kind === 'vote' && e.seat !== undefined) {
      const list = st.votesByDay.get(e.day) ?? [];
      list.push({ seat: e.seat, target: e.target ?? null });
      st.votesByDay.set(e.day, list);
    } else if (e.kind === 'exile') st.exiles.set(e.day, e.seat ?? null);
  }
  return st;
}

const aliveSeats = (st: GameState): Seat[] => st.view.players.filter((p) => p.alive).map((p) => p.seat);
const isAlive = (st: GameState, seat: Seat): boolean => st.view.players.find((p) => p.seat === seat)?.alive ?? false;
const nameOf = (st: GameState, seat: Seat): string => st.view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;
const who = (st: GameState, seat: Seat): string => `seat ${seat} (${nameOf(st, seat)})`;

// ---------------------------------------------------------------------------
// Judging the seer claims: who to believe, who is exposed.
// ---------------------------------------------------------------------------

/**
 * A claimant is proven fake when one of their reports is contradicted by a
 * revealed role: a "werewolf" who flipped village-side, or a "clean" who
 * flipped werewolf. Returns the set of proven-fake claimant seats.
 */
function provenFakeClaimants(st: GameState): Set<Seat> {
  const fake = new Set<Seat>();
  for (const r of st.claims.reports) {
    const flipped = st.revealed.get(r.target);
    if (flipped === undefined) continue;
    if (r.werewolf && flipped !== 'werewolf') fake.add(r.by);
    if (!r.werewolf && flipped === 'werewolf') fake.add(r.by);
  }
  // Two living claimants and only one real seer: if either is proven fake the
  // other is cleared of that doubt; both cannot be believed at once.
  return fake;
}

/**
 * The credible seer claimant for the village. Proven fakes are out. Among the
 * rest, score each claimant: a report confirmed by a revealed role counts
 * most; claiming before any rival counts, because the real seer claims on
 * their own schedule while a caught wolf claims in reaction; a claimant who
 * is themselves the named wolf of an earlier claimant, and claimed only after
 * being named, is read as the wolf's forced counterclaim.
 */
function credibleSeer(st: GameState): Seat | null {
  const fake = provenFakeClaimants(st);
  // A claimant who died and was revealed as the seer told the truth: their
  // reports are facts, and they outrank every living claim.
  const confirmedDead = st.claims.seerClaimants.find((s) => !isAlive(st, s) && st.revealed.get(s) === 'seer' && s !== st.me);
  if (confirmedDead !== undefined) return confirmedDead;
  const living = st.claims.seerClaimants.filter((s) => isAlive(st, s) && !fake.has(s) && s !== st.me);
  if (living.length === 0) return null;
  if (living.length === 1) return living[0]!;
  let best: Seat | null = null;
  let bestScore = -Infinity;
  for (const s of living) {
    let score = 0;
    const confirmed = st.claims.reports.some((r) => r.by === s && st.revealed.get(r.target) !== undefined &&
      ((r.werewolf && st.revealed.get(r.target) === 'werewolf') || (!r.werewolf && st.revealed.get(r.target) !== 'werewolf')));
    if (confirmed) score += 5;
    // Claimed before every rival: the proactive claim.
    if (living.every((o) => o === s || st.claims.seerClaimants.indexOf(s) < st.claims.seerClaimants.indexOf(o))) score += 2;
    // Named a wolf by an earlier claimant, then claimed: a reaction, not a lead.
    const namedByEarlier = st.claims.reports.some((r) => r.target === s && r.werewolf &&
      st.claims.seerClaimants.indexOf(r.by) < st.claims.seerClaimants.indexOf(s));
    if (namedByEarlier) score -= 4;
    // I named them myself (as the seer) and they are not a wolf: they may be
    // a villager bluffing, but they are not the wolf we hunt first.
    if (st.myRole === 'seer' && (st.view.seerResults ?? []).some((r) => r.seat === s && !r.werewolf)) score -= 1;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

/** My own earlier speeches in this game. */
function mySpeeches(st: GameState): string[] {
  return st.view.log.filter((e) => e.kind === 'speech' && e.seat === st.me && typeof e.text === 'string').map((e) => e.text as string);
}

/** The seat my own seer claim (real or not) named as a checked werewolf. */
function myClaimedWolfTarget(st: GameState): Seat | null {
  for (const text of mySpeeches(st)) {
    if (!/\bi am the (real )?seer\b/i.test(text)) continue;
    const m = /checked (?:seat )?(\d{1,2})[^.!?]*a werewolf/i.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The living seat a credible seer has named a werewolf, if any. */
function seerNamedWolf(st: GameState): Seat | null {
  const seer = credibleSeer(st);
  if (seer === null) return null;
  const report = st.claims.reports.find((r) => r.by === seer && r.werewolf && isAlive(st, r.target) && r.target !== st.me);
  return report?.target ?? null;
}

/** Seats a credible seer has named clean (and who are still alive). */
function seerCleared(st: GameState): Set<Seat> {
  const out = new Set<Seat>();
  const seer = credibleSeer(st);
  if (seer === null) return out;
  for (const r of st.claims.reports) if (r.by === seer && !r.werewolf && isAlive(st, r.target)) out.add(r.target);
  return out;
}

// ---------------------------------------------------------------------------
// Suspicion: the villager's running read of the table.
// ---------------------------------------------------------------------------

function suspicionScores(st: GameState): Map<Seat, number> {
  const scores = new Map<Seat, number>();
  const add = (seat: Seat, v: number) => scores.set(seat, (scores.get(seat) ?? 0) + v);
  const fake = provenFakeClaimants(st);
  for (const seat of aliveSeats(st)) {
    if (seat === st.me) continue;
    // Proven fake claimants are wolves (or worse than useless): top suspicion.
    if (fake.has(seat)) add(seat, 6);
    // Table talk accusing them.
    add(seat, 0.45 * (st.claims.accusations.get(seat) ?? 0));
    // Very quiet players hide something, or at least give the village nothing.
    const said = st.speechCount.get(seat) ?? 0;
    if (said === 0 && st.view.day >= 2) add(seat, 0.8);
    else if (said <= 1 && st.view.day >= 3) add(seat, 0.5);
  }
  // Vote records: voting with a revealed wolf, or for a revealed villager.
  for (const [day, votes] of st.votesByDay) {
    void day;
    for (const v of votes) {
      if (v.target === null || !isAlive(st, v.seat)) continue;
      const targetRole = st.revealed.get(v.target);
      if (targetRole !== undefined && targetRole !== 'werewolf') add(v.seat, 0.55);
      if (targetRole === 'werewolf') add(v.seat, -0.8);
    }
  }
  // Who voted alongside a revealed wolf, for the same target?
  for (const votes of st.votesByDay.values()) {
    const wolfTargets = new Set(votes.filter((v) => st.revealed.get(v.seat) === 'werewolf' && v.target !== null).map((v) => v.target));
    for (const v of votes) {
      if (v.target !== null && wolfTargets.has(v.target) && st.revealed.get(v.seat) === undefined) add(v.seat, 0.5);
    }
  }
  // A revealed werewolf who claimed seer was lying both ways: the players
  // they "cleared" are likelier their partner, and the ones they named
  // werewolves were likelier framed villagers.
  for (const r of st.claims.reports) {
    if (st.revealed.get(r.by) !== 'werewolf') continue;
    add(r.target, r.werewolf ? -1.5 : 1.5);
  }
  // My own inspections, when I am the seer, are certainties, not heuristics.
  if (st.myRole === 'seer') {
    for (const r of st.view.seerResults ?? []) add(r.seat, r.werewolf ? 9 : -9);
  }
  // The credible seer's word outweighs the heuristics.
  const named = seerNamedWolf(st);
  if (named !== null) add(named, 8);
  for (const seat of seerCleared(st)) add(seat, -8);
  const seer = credibleSeer(st);
  if (seer !== null) add(seer, -8);
  // A claimed doctor is left alone unless proven fake.
  for (const d of st.claims.doctorClaimants) if (!fake.has(d)) add(d, -2.5);
  return scores;
}

/** Today's votes so far (the voting phase is sequential and public). */
function todaysVotes(st: GameState): { seat: Seat; target: Seat | null }[] {
  return st.votesByDay.get(st.view.day) ?? [];
}

function tallyOf(votes: { seat: Seat; target: Seat | null }[]): Map<Seat, number> {
  const tally = new Map<Seat, number>();
  for (const v of votes) if (v.target !== null) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
  return tally;
}

// ---------------------------------------------------------------------------
// Night decisions.
// ---------------------------------------------------------------------------

function decideInspect(p: Pending, st: GameState): Seat | null {
  const options = (p.options ?? []).filter((s) => s !== st.me);
  if (options.length === 0) return null;
  const known = new Set((st.view.seerResults ?? []).map((r) => r.seat));
  const rng = rngFor(trialSeed(), p.game, 'inspect', st.view.day, st.view.log.length);
  const weight = (s: Seat): number => {
    let w = 1;
    if (known.has(s)) w -= 100;
    // A rival claimant first: knowing whether they are a wolf settles the 1v1.
    if (st.claims.seerClaimants.includes(s)) w += 6;
    // Then anyone another claimant vouched for: their word is only as good as
    // the player they cleared.
    if (st.claims.reports.some((r) => r.target === s && !r.werewolf)) w += 2.5;
    // Then the table's suspicions, then the quiet.
    w += 0.6 * (suspicionScores(st).get(s) ?? 0);
    if ((st.speechCount.get(s) ?? 0) === 0) w += 0.8;
    return w;
  };
  return pickWeighted(rng, options, weight);
}

function decideProtect(p: Pending, st: GameState): Seat | null {
  const options = p.options ?? [];
  if (options.length === 0) return null;
  const rng = rngFor(trialSeed(), p.game, 'protect', st.view.day, st.view.log.length);
  const seer = credibleSeer(st);
  const weight = (s: Seat): number => {
    let w = 1;
    // The revealed seer is the wolves' first target: guard them.
    if (s === seer) w += 10;
    // A claimant not yet proven either way is worth guarding too.
    if (st.claims.seerClaimants.includes(s)) w += 4;
    // A player the seer cleared is a known villager and a trusted voice.
    if (seerCleared(st).has(s)) w += 2.5;
    // Whoever led a successful wolf exile draws the next kill.
    for (const votes of st.votesByDay.values()) {
      void votes;
    }
    for (const [day, exiled] of st.exiles) {
      void day;
      if (exiled !== null && st.revealed.get(exiled) === 'werewolf') {
        // The loudest accuser of that wolf, by talk.
        if ((st.claims.accusations.get(s) ?? 0) > 0) w += 0.2;
      }
    }
    // Vocal players are likelier targets than silent ones.
    w += 0.3 * Math.min(3, st.speechCount.get(s) ?? 0);
    return w;
  };
  return pickWeighted(rng, options, weight);
}

function decideKill(p: Pending, st: GameState): Seat | null {
  const options = p.options ?? [];
  if (options.length === 0) return null;
  const partner = st.view.you.partner?.seat ?? null;
  // The second wolf agrees with the first's pick: a split vote kills nobody.
  const tonight = (st.view.wolfVotes ?? []).filter((v) => v.night === st.view.day && v.seat !== st.me);
  const partnerPick = tonight.find((v) => v.target !== null)?.target ?? null;
  if (partnerPick !== null && options.includes(partnerPick)) return partnerPick;
  const rng = rngFor(trialSeed(), p.game, 'kill', st.view.day, st.view.log.length);
  const seer = credibleSeer(st);
  const lastNightNoKill = st.view.day >= 2 && st.dawnDeaths.get(st.view.day) === null;
  const weight = (s: Seat): number => {
    let w = 1;
    if (s === partner) w -= 100;
    // The seer first. If last night's kill failed with a seer already out,
    // the doctor covered them — and cannot cover the same seat twice in a
    // row, so tonight they are open.
    if (s === seer) w += lastNightNoKill ? 14 : 9;
    if (st.claims.seerClaimants.includes(s)) w += 5;
    // A claimed doctor keeps the seer alive: remove them.
    if (st.claims.doctorClaimants.includes(s)) w += 4;
    // Players gunning for me or my partner are dangerous.
    for (const e of st.view.log) {
      if (e.kind === 'speech' && typeof e.text === 'string') {
        const t = e.text.toLowerCase();
        if ((t.includes(`seat ${st.me}`) || t.includes(`seat ${partner}`)) && /\bwerewolf|wolf|suspicious|vote\b/.test(t)) {
          if (e.seat === s) w += 2;
        }
      }
    }
    // Trusted, vocal villagers lead the town: worth more dead than quiet ones.
    if (seerCleared(st).has(s)) w += 2;
    w += 0.35 * Math.min(4, st.speechCount.get(s) ?? 0);
    return w;
  };
  return pickWeighted(rng, options, weight);
}

// ---------------------------------------------------------------------------
// Day decisions: speech.
// ---------------------------------------------------------------------------

function mySeerResults(st: GameState): { seat: Seat; werewolf: boolean }[] {
  return (st.view.seerResults ?? []).map((r) => ({ seat: r.seat, werewolf: r.werewolf }));
}

/** Whether my seer claim should come out in this debate. */
function seerRevealDue(st: GameState, round: number): boolean {
  if (st.myRole !== 'seer') return false;
  const results = mySeerResults(st);
  const knownWolf = results.find((r) => r.werewolf && isAlive(st, r.seat));
  if (knownWolf) return true;
  // A rival claim that contradicts my results must be answered at once.
  const fake = provenFakeClaimants(st);
  const rival = st.claims.seerClaimants.find((s) => s !== st.me && isAlive(st, s));
  if (rival !== undefined && (fake.has(rival) || st.claims.reports.some((r) => r.by === rival && results.some((mine) => mine.seat === r.target && mine.werewolf !== r.werewolf)))) return true;
  // By day 2, with two nights of checks, the record is worth more than my
  // hiding: the cleared seats shrink the wolf pool while the parity clock
  // still leaves the village room to use the information.
  if (st.view.day >= 2 && results.length >= 2) return true;
  // Round 2 with votes gathering on me: claim to live.
  if (round === 2 && (st.claims.accusations.get(st.me) ?? 0) >= 2) return true;
  return false;
}

function seerClaimText(st: GameState): string {
  const results = mySeerResults(st);
  const parts = results.map((r, i) => `night ${i + 1} I checked ${who(st, r.seat)}: ${r.werewolf ? 'a werewolf' : 'not a werewolf'}`);
  const wolf = results.find((r) => r.werewolf && isAlive(st, r.seat));
  if (wolf) return `I am the seer. ${parts.join('; ')}. Vote ${who(st, wolf.seat)} today. Doctor, please protect me tonight.`;
  // No wolf caught yet: the cleared seats are the news. Name the pool the
  // wolves must hide in and push its most suspicious member, so the claim
  // still directs today's exile.
  const known = new Set(results.map((r) => r.seat));
  const pool = aliveSeats(st).filter((s) => s !== st.me && !known.has(s) && !st.claims.seerClaimants.includes(s));
  const scores = suspicionScores(st);
  const target = pool.slice().sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))[0];
  const poolText = pool.map((s) => who(st, s)).join(', ');
  return `I am the seer. ${parts.join('; ')}. The werewolves are hiding among ${poolText}.${target !== undefined ? ` Of those, ${who(st, target)} reads most like a wolf; that is my vote today.` : ''} Doctor, please protect me tonight.`;
}

/** Follow-up speech once my seer claim is already on the table. */
function seerFollowUpText(st: GameState): string {
  const target = myClaimedWolfTarget(st);
  const rival = st.claims.seerClaimants.find((s) => s !== st.me && isAlive(st, s));
  if (rival !== undefined && target !== null) {
    const myClaimSeq = st.view.log.find((e) => e.kind === 'speech' && e.seat === st.me && typeof e.text === 'string' && /\bi am the (real )?seer\b/i.test(e.text))?.seq ?? Infinity;
    const rivalClaimSeq = st.view.log.find((e) => e.kind === 'speech' && e.seat === rival && typeof e.text === 'string' && /\bi(?:'m| am) (?:the )?seer\b|\bi claim (?:the )?seer\b/i.test(e.text))?.seq ?? Infinity;
    if (myClaimSeq < rivalClaimSeq) {
      return `Remember the order of events: I claimed first, with a check from the night; ${who(st, rival)} claimed only after I named them. A caught wolf would say exactly that. Vote ${who(st, target)} today.`;
    }
    return `${who(st, rival)} asks you to believe them over me. Test the records: my checks are on the table from the start, and they point to ${who(st, target)}. Vote there today.`;
  }
  if (target !== null) return `My claim stands and the vote is clear: ${who(st, target)} is a werewolf. Please vote with me so the exile lands.`;
  const results = mySeerResults(st);
  const wolf = results.find((r) => r.werewolf && isAlive(st, r.seat));
  if (wolf) return `Vote ${who(st, wolf.seat)} today: my check says werewolf, and every village vote needs to land there.`;
  return seerClaimText(st);
}

function currentRound(st: GameState): number {
  const speeches = st.view.log.filter((e) => (e.kind === 'speech' || e.kind === 'pass') && e.day === st.view.day);
  const living = Math.max(1, aliveSeats(st).length);
  return Math.floor(speeches.length / living) + 1;
}

function villagerSpeech(st: GameState, round: number): string | null {
  const rng = rngFor(trialSeed(), 'speech', st.view.day, round, st.view.log.length, st.me);
  const named = seerNamedWolf(st);
  const seer = credibleSeer(st);
  const fake = provenFakeClaimants(st);
  const fakeAlive = [...fake].find((s) => isAlive(st, s) && s !== st.me);
  if (fakeAlive !== undefined) {
    return pick(rng, [
      `${who(st, fakeAlive)} claimed seer, but their report does not match the revealed roles. A real seer's checks cannot flip like that: ${nameOf(st, fakeAlive)} is a werewolf. I will vote ${who(st, fakeAlive)}.`,
      `Look at the record: ${who(st, fakeAlive)}'s seer story is contradicted by players whose roles we now know. That claim was a wolf's cover. Vote ${who(st, fakeAlive)} today.`,
    ]);
  }
  // Two rival claims: argue for the one the credibility read picked, on the
  // timing — the real seer claimed first, the wolf claimed in reaction.
  const rivals = st.claims.seerClaimants.filter((s) => isAlive(st, s) && s !== st.me);
  if (rivals.length >= 2 && seer !== null) {
    const other = rivals.find((s) => s !== seer);
    if (other !== undefined) {
      return `${who(st, seer)} claimed first, openly, with checks we can test. ${who(st, other)} claimed only once the pressure turned. I believe ${nameOf(st, seer)}, and I will vote where they point.`;
    }
  }
  if (named !== null && seer !== null) {
    return pick(rng, [
      `${who(st, seer)} is our seer and they named ${who(st, named)} as a werewolf. I believe them, and I will vote ${who(st, named)} today.`,
      `The seer's word is the best information we have: ${who(st, named)} was checked and is a werewolf. My vote goes to ${who(st, named)}.`,
    ]);
  }
  if (round === 2) {
    const scores = suspicionScores(st);
    let best: Seat | null = null;
    let bestScore = 0.9;
    for (const [seat, score] of scores) if (score > bestScore && isAlive(st, seat)) { bestScore = score; best = seat; }
    if (best !== null) {
      return pick(rng, [
        `Weighing the votes and the talk, ${who(st, best)} looks most like a werewolf to me. I will vote ${who(st, best)} unless the seer speaks up.`,
        `My vote today goes to ${who(st, best)}: their record fits a werewolf better than anyone else's.`,
      ]);
    }
    return null;
  }
  // Round 1 without hard information: a light read, or silence.
  const died = st.dawnDeaths.get(st.view.day);
  if (st.view.day === 1 && died !== null && died !== undefined) {
    return pick(rng, [
      `Losing ${who(st, died)} hurts. I have no hard information yet; I am listening for claims and watching who pushes votes without reasons.`,
      `${who(st, died)} is gone. Rather than guess wildly, let us hear everyone's read today and vote on the strongest one.`,
    ]);
  }
  return null;
}

function wolfSpeech(st: GameState, round: number): string | null {
  const rng = rngFor(trialSeed(), 'wolf-speech', st.view.day, round, st.view.log.length, st.me);
  const partner = st.view.you.partner?.seat ?? null;
  const named = seerNamedWolf(st);
  // Outed by the seer: counterclaim, naming the seer as my checked wolf.
  if (named === st.me) {
    const seer = credibleSeer(st);
    if (seer !== null) {
      const cleared = aliveSeats(st).find((s) => s !== st.me && s !== seer && s !== partner && !st.claims.seerClaimants.includes(s));
      return `Do not be fooled: I am the real seer. I checked ${who(st, seer)} and they are a werewolf; their claim is a wolf's trick to have me exiled.${cleared ? ` I also checked ${who(st, cleared)} earlier: not a werewolf.` : ''} Vote ${who(st, seer)}.`;
    }
  }
  // Partner outed and the wagon is real: distance, do not defend.
  if (named !== null && named === partner) {
    return pick(rng, [
      `If ${who(st, named)} was truly checked, we cannot ignore it. I will hear them out, but the seer's word is hard to argue with.`,
      `That is a serious claim against ${who(st, named)}. Unless they can answer it, my vote may have to follow the seer.`,
    ]);
  }
  // Already fake-claimed on an earlier day: stay on the same story and keep
  // pushing the same named wolf, like a real seer would.
  const myFakeTarget = myClaimedWolfTarget(st);
  if (myFakeTarget !== null && isAlive(st, myFakeTarget)) {
    return pick(rng, [
      `My claim stands: I checked ${who(st, myFakeTarget)} and found a werewolf. Vote ${who(st, myFakeTarget)} today.`,
      `Nothing has changed my read. The vote belongs on ${who(st, myFakeTarget)}.`,
    ]);
  }
  // The real seer is dead and nobody claims the role: a fake claim can steer
  // the whole day. Fabricate a consistent record: cleared partner, a dead
  // villager cleared, and one living villager named as the wolf.
  const seerDead = [...st.revealed.entries()].some(([, r]) => r === 'seer');
  const livingClaimants = st.claims.seerClaimants.filter((s) => isAlive(st, s));
  if (seerDead && livingClaimants.length === 0 && st.view.day >= 2 && round === 1) {
    const targets = aliveSeats(st).filter((s) => s !== st.me && s !== partner && !seerCleared(st).has(s));
    const deadClean = [...st.revealed.entries()].find(([, r]) => r === 'villager' || r === 'doctor')?.[0];
    if (targets.length > 0) {
      const victim = pick(rng, targets);
      const partnerLine = partner !== null && isAlive(st, partner) ? ` I checked ${who(st, partner)} too: not a werewolf.` : '';
      const deadLine = deadClean !== undefined ? ` Earlier I checked ${who(st, deadClean)}: not a werewolf, which fits.` : '';
      return `I am the seer; I stayed quiet while I gathered results. Last night I checked ${who(st, victim)}: a werewolf.${partnerLine}${deadLine} Vote ${who(st, victim)} today.`;
    }
  }
  // Blend in: echo the town's direction against a village target, never the
  // partner, never myself.
  const scores = suspicionScores(st);
  let best: Seat | null = null;
  let bestScore = 1.1;
  for (const [seat, score] of scores) {
    if (seat === partner || seat === st.me) continue;
    if (score > bestScore && isAlive(st, seat)) { bestScore = score; best = seat; }
  }
  if (best !== null && round === 2) {
    return pick(rng, [
      `I have been listening, and ${who(st, best)} still looks most suspicious to me. That is where my vote is going.`,
      `The case on ${who(st, best)} makes sense to me. I will vote with it.`,
    ]);
  }
  if (st.view.day === 1 && round === 1) {
    return pick(rng, [
      `A sad start. I have no information yet, so I will listen today and vote on behaviour, not noise.`,
      `Let us stay calm and compare reads. Wild votes only help the werewolves.`,
    ]);
  }
  return null;
}

function decideSpeak(p: Pending, st: GameState): Record<string, unknown> {
  const maxChars = p.max_chars ?? 500;
  const round = currentRound(st);
  let text: string | null = null;
  // Defense first: a wagon forming on me changes what I say.
  const accused = (st.claims.accusations.get(st.me) ?? 0) >= 2;
  if (st.myRole === 'seer') {
    const alreadyClaimed = mySpeeches(st).some((t) => /\bi am the (real )?seer\b/i.test(t));
    if (alreadyClaimed) text = seerFollowUpText(st);
    else if (seerRevealDue(st, round)) text = seerClaimText(st);
    else if (round === 1) {
      // Hidden, the seer's voice is worth more alive than heard: keep a low
      // profile so the wolves' kill goes elsewhere, unless there is a claim
      // on the table that needs an answer.
      const rng = rngFor(trialSeed(), 'seer-quiet', st.view.day, st.view.log.length, st.me);
      text = st.claims.seerClaimants.length > 0 || rng() < 0.4 ? villagerSpeech(st, round) : null;
    } else text = villagerSpeech(st, round);
  } else if (st.myRole === 'werewolf') {
    text = wolfSpeech(st, round);
    if (text === null && accused) {
      text = `I hear the suspicion on me, but it is misplaced: I am a villager, and my votes will show it. Look at the voting record before you waste an exile on me.`;
    }
  } else {
    if (accused && st.myRole === 'doctor' && round === 2) {
      text = `Do not exile me: I am the doctor. I have been protecting quietly every night, and the village needs those saves. Look elsewhere today.`;
    } else if (accused) {
      text = `I am on the village's side, and exiling me wastes a day we cannot spare. Judge me by my votes: I have only ever voted where the evidence pointed.`;
    } else {
      text = villagerSpeech(st, round);
    }
  }
  if (text === null || foldStatement(text) === '') return { game: p.game, decision: 'speak', pass: true };
  return { game: p.game, decision: 'speak', text: fitStatement(text, maxChars) };
}

// ---------------------------------------------------------------------------
// Day decisions: the vote.
// ---------------------------------------------------------------------------

function decideVote(p: Pending, st: GameState): Seat | null {
  const options = (p.options ?? []).filter((s) => s !== st.me);
  if (options.length === 0) return null;
  const rng = rngFor(trialSeed(), p.game, 'vote', st.view.day, st.view.log.length);
  const votes = todaysVotes(st);
  const tally = tallyOf(votes);
  const partner = st.view.you.partner?.seat ?? null;

  if (st.myRole === 'werewolf') {
    // A credible seer has outed the partner: bus them, the game is bigger.
    const named = seerNamedWolf(st);
    if (named !== null && named === partner) return partner;
    // If the partner is the runaway wagon anyway, join late for cover.
    const partnerVotes = tally.get(partner ?? -1) ?? 0;
    if (partner !== null && partnerVotes >= 3) return partner;
    // Save the partner when my vote can push a villager past them.
    const candidates = options.filter((s) => s !== partner);
    const best = pickWeighted(rng, candidates, (s) => {
      let w = 1 + 1.6 * (tally.get(s) ?? 0);
      if (s === credibleSeer(st)) w += 2.5;
      if ((st.claims.accusations.get(s) ?? 0) > 0) w += 0.4;
      return w;
    });
    return best;
  }

  // Village side.
  if (st.myRole === 'seer') {
    const results = mySeerResults(st);
    const wolf = results.find((r) => r.werewolf && isAlive(st, r.seat) && options.includes(r.seat));
    if (wolf) return wolf.seat;
    // A claimant I inspected and found a wolf is a wolf, whatever they said.
    const wolfClaimant = st.claims.seerClaimants.find((s) => options.includes(s) && results.some((r) => r.seat === s && r.werewolf));
    if (wolfClaimant !== undefined) return wolfClaimant;
  }
  const named = seerNamedWolf(st);
  if (named !== null && options.includes(named)) {
    // My own check beats another claimant's word: if the "wolf" they named
    // is a player I inspected and found clean, the claimant is the fake and
    // they, not their target, get my vote.
    if (st.myRole === 'seer' && (st.view.seerResults ?? []).some((r) => r.seat === named && !r.werewolf)) {
      const claimant = credibleSeer(st);
      if (claimant !== null && options.includes(claimant)) return claimant;
    } else return named;
  }
  const fakeAlive = [...provenFakeClaimants(st)].find((s) => isAlive(st, s) && options.includes(s) &&
    !(st.myRole === 'seer' && (st.view.seerResults ?? []).some((r) => r.seat === s && !r.werewolf)));
  if (fakeAlive !== undefined) return fakeAlive;
  const scores = suspicionScores(st);
  const cleared = seerCleared(st);
  const seer = credibleSeer(st);
  // Defensive block: if the wagon is about to exile a player the village
  // cannot afford to lose (the credible seer, a seer-cleared player, an
  // unexposed doctor claimant) and a rival candidate is within one vote,
  // vote the rival to force a tie and no exile.
  const protectedSeats = new Set<Seat>([...cleared, ...(seer !== null ? [seer] : []),
    ...st.claims.doctorClaimants.filter((d) => !provenFakeClaimants(st).has(d))]);
  const leaders = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (leaders.length >= 2) {
    const [leadSeat, leadVotes] = leaders[0]!;
    const [secondSeat, secondVotes] = leaders[1]!;
    if (protectedSeats.has(leadSeat) && leadVotes >= 2 && secondVotes >= leadVotes - 1 &&
      options.includes(secondSeat) && !protectedSeats.has(secondSeat)) return secondSeat;
  }
  const pool = options.filter((s) => s !== seer && !cleared.has(s) &&
    !(st.myRole === 'seer' && (st.view.seerResults ?? []).some((r) => r.seat === s && !r.werewolf)));
  if (pool.length === 0) return null;
  const best = pickWeighted(rng, pool, (s) => (scores.get(s) ?? 0) + 0.55 * (tally.get(s) ?? 0));
  // With no real signal on day 1, an abstention beats a coin-flip exile: a
  // blind exile hits a villager far more often than a wolf, and the seer's
  // second check is worth more than the flip.
  const rawBest = Math.max(...pool.map((s) => scores.get(s) ?? 0));
  if (st.view.day === 1 && rawBest < 1.6 && seer === null) return null;
  void votes;
  return best;
}

// ---------------------------------------------------------------------------
// The run: answer every decision the env lists until the trial is done.
// ---------------------------------------------------------------------------

async function envPost(envUrl: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${envUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function actFor(p: Pending): Record<string, unknown> {
  const st = buildState(p.view);
  switch (p.decision) {
    case 'speak':
      return decideSpeak(p, st);
    case 'vote':
      return { game: p.game, decision: 'vote', target: decideVote(p, st) };
    case 'kill':
      return { game: p.game, decision: 'kill', target: decideKill(p, st) };
    case 'protect':
      return { game: p.game, decision: 'protect', target: decideProtect(p, st) };
    case 'inspect':
      return { game: p.game, decision: 'inspect', target: decideInspect(p, st) };
  }
}

const fallbackFor = (p: Pending): Record<string, unknown> =>
  p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };

export async function run(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  let idleRounds = 0;
  for (let round = 0; round < 200000; round++) {
    const obs = await envPost(envUrl, '/observe', {});
    if (obs.status !== 200 || obs.body === null || typeof obs.body !== 'object') {
      idleRounds += 1;
      if (idleRounds > 50) throw new Error(`POST /observe answered ${obs.status}`);
      continue;
    }
    const o = obs.body as Observed;
    if (o.done) break;
    idleRounds = 0;
    for (const p of o.pending) {
      let act: Record<string, unknown>;
      try {
        act = actFor(p);
      } catch {
        act = fallbackFor(p);
      }
      const posted = await envPost(envUrl, '/act', act);
      if (posted.status !== 200) {
        // Refused (stale or malformed): fall back to the safe answer once.
        const fb = fallbackFor(p);
        if (JSON.stringify(fb) !== JSON.stringify(act)) await envPost(envUrl, '/act', fb);
      }
    }
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
