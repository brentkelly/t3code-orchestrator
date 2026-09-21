# Freeing the dev ports

A T3o-owned note. It lived in `docs/internals/scripts.md` until upstream deleted that file
(`v0.0.42` sync, T3O-46); `scripts/kill-dev.ts` is fork-owned, so its documentation moved here.

`npm run kill` stops whatever holds this checkout's dev ports. It resolves the same ports
`npm run dev` prefers — `T3CODE_PORT` (or `.env`) for the backend, otherwise `13773`/`5733` plus this
worktree's offset — finds the listeners, and kills each one's whole process group, which is the unit
`npm run dev` occupies (`sh -c` wrapper, `dev-runner`, `vp run`, the `node --watch` supervisor, the
server). Killing the listener alone is not enough: `node --watch` restarts it onto the same port.

- `npm run kill -- 3773 5733` clears the given ports instead, which is the way to reach an instance
  whose ports were shifted by collision scanning — that scan lands on the first _free_ port, so it
  cannot be replayed to rediscover a busy one. Read the port off the `[dev-runner]` line.
- `npm run kill -- --dry-run` lists the processes it would signal.
- SIGTERM first, SIGKILL for whatever is still alive 5s later. A group led by a shell session, or
  this script's own group, falls back to the listener and its descendants; if the port stays held
  the command says so rather than reporting success.
