# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd or launchd. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state while the service is stopped. Foreground CLI
processes do not self-update.

Exact-version installs keep restarts independent of npm cache eviction or a moving
release tag. Installation and preflight happen in staging before publishing an
immutable runtime. Preflight checks the launcher protocol because a target that
needs new rollback guarantees cannot safely run under an older launcher. Upgrading
that launcher requires a local service update.

## Commit boundary

The launcher durably records the pending update before acknowledging it, then
stops the old child and starts the target as a trial. Service-state writes use
same-directory replacement with file and directory fsync. Invalid state stops
startup rather than guessing which runtime to boot.

The trial must finish migrations, acquire dependencies, bind HTTP, and park every
long-running root at the activation gate before reporting `prepared`. The launcher
then commits the target version durably and replies `committed`. Only then may the
child release its gates, accept commands, and publish ready. Keep fallible startup
acquisitions before this boundary. A listener alone does not prove the runtime is
ready to commit.

A failed or timed-out trial returns to the old version. After commit, the target
is authoritative and the service manager's ordinary restart policy applies.

## Database rollback

After the old child exits, the launcher snapshots SQLite's main file, WAL, and
shared-memory file. This makes trial migrations reversible without down
migrations. The snapshot is made once per update and survives launcher restarts;
replacing it during a retry could capture changes from the failed trial.

Rollback stops the trial before restoring. A durable restore marker makes an
interrupted restore finish before either version boots. Keep the snapshot until
commit, or until both restoration and the terminal rollback state are durable.
Attachments and other files outside SQLite are outside this rollback boundary.

### Every database, not just `state.sqlite` (T3o)

<!-- T3o: the fork keeps board data in its own `boards.sqlite`, so the launcher's snapshot covers every database (launcher protocol 3). -->

In T3o the launcher snapshots **every `*.sqlite` file in the state directory**, along with each
one's `-wal` and `-shm` sidecars. The set is discovered from disk rather than named, so a database
added later is covered without the launcher having to know what it is for — today that means
`state.sqlite` and t3o's `boards.sqlite`.

Restoring covers the union of what was backed up and what is live. A database the trial update
_created_ has no snapshot entry and is **deleted** on restore, because leaving it would let the
reverted build read a database from the future — migrated by the newer version, with a migration
ledger claiming it is current, so nothing re-runs to reconcile it.

Because snapshots are durable across launcher restarts, a restore can meet a directory written by an
older launcher, whose layout was a single database stored as `database` / `database-wal` /
`database-shm`. That layout is recognised and mapped to the primary database — and under it the
deletion rule above does **not** apply: only the primary is restored, and every other database is
left exactly as it is. A legacy snapshot proves the launcher that wrote it was old, not that the
server was; it says nothing about `boards.sqlite`, which may hold the only copy of the board data.
Only the current layout can claim to know the full pre-update set.

A directory matching _neither_ layout makes the restore **refuse loudly** rather than proceed: a
restore that recognises nothing would otherwise delete the databases and restore nothing. Failing is
recoverable by hand; deleting is not.

The protocol version is part of the safety boundary. Protocol 3 is the version that snapshots every
database in the state directory; a server keeping data in more than one file must not be trialled
under an older launcher, which would snapshot only `state.sqlite` and leave the rest migrated
forward after a rollback.

## Client acknowledgement

An accepted update is still pending. Clients correlate the launcher's update ID
with the ready event after reconnecting, then check the outcome and target version.
A reconnect alone cannot distinguish successful replacement from rollback. Older
servers without an update ID retain version-only correlation.

Desktop updates have a separate two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.
