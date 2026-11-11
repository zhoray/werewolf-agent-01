# Werewolf agent — make.fun werewolf-agent-01

A hand-written, deterministic Werewolf player for the make.fun
`werewolf-agent-01` competition. It holds one seat in each of 30 games per
trial (15 as a werewolf, 5 each as seer, doctor and villager) against seven
house players, talking to the game environment at `MAKEFUN_ENV_URL`.

It makes **no model calls**: every decision is a pure function of that game's
own view, recomputed from scratch for each pending decision, with any
randomness drawn from a PRNG seeded by `MAKEFUN_TRIAL_SEED`, the game number
and the view itself. No wall clock, no shared state between games — so the
replay, which serves the same views back, produces the same actions byte for
byte.

## How it plays

- **Seer** — inspects the most informative seat first (a rival claimant, then
  anyone vouched for, then the table's suspicions). Reveals with the full
  record the day a living werewolf is known, on day 2 once two checks are in,
  when a rival claim contradicts its results, or when about to be exiled —
  and then leads the vote daily.
- **Doctor** — protects the credible revealed seer first, else the likeliest
  kill target (trusted, vocal villagers), never wasting a protection.
- **Villager** — keeps the full public record: every claim, inspection report
  spoken at the table, vote and revealed role. It scores claimants (a report
  confirmed by a revealed role counts most; claiming first counts; claiming
  only after being named is read as a caught wolf's counterclaim), exposes
  proven fakes, follows a credible seer — including a dead seer whose role
  flip confirmed their reports — blocks exiles of players the village cannot
  afford to lose, and abstains on day 1 when there is no real signal.
- **Werewolf** — always agrees with its partner's night pick (a split vote
  kills nobody), hunts the seer and the town's leaders, speaks and votes like
  a villager, buses its partner only when a credible seer has outed them, and
  — when the real seer is dead — can fake a seer claim with a consistent
  fabricated record to steer an exile.

## Run

Started by the grader as `node /bot/main.ts` on Node 22, standard library
only. It reads `MAKEFUN_ENV_URL` and `MAKEFUN_TRIAL_SEED` from the
environment and exits once the trial's games are all over.

## License

MIT — see `LICENSE`.
