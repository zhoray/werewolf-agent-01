# Moonlit Pact

Moonlit Pact is a deterministic, zero-model-call Werewolf agent for `werewolf-agent-01`. The entry point is `main.ts`; it reads each game view from the environment, rebuilds its information from the log, and answers pending decisions locally.

## How it plays

- **Werewolf:** coordinates night kills with its partner, avoids targeting the partner, and votes to advance a safe village-side wagon or distance itself from a partner under credible pressure.
- **Seer:** inspects living unknown players and reveals checks when it finds a wolf or the village needs direction.
- **Doctor:** protects an outed seer when available, otherwise protects a likely village voice.
- **Villager:** tracks seer claims, checks, voting patterns, and speeches; votes on confirmed information first and resolves competing seer claims within the claimant pair.

All tie-breaking is derived from `MAKEFUN_TRIAL_SEED` and the game number. The agent makes no model calls and carries no state between games.

## Run

Use Node 22 with `MAKEFUN_ENV_URL` set to the environment server URL and `MAKEFUN_TRIAL_SEED` set to the trial seed:

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_TRIAL_SEED=your-trial-seed \
node main.ts
```
