---
id: t3o-02a
title: Seam generalisation — make the core open for extension, once
phase: 0
prerequisites: [t3o-02]
---

# Seam generalisation

Convert every seam from **enumerating one board feature** to **delegating to the board module**, so
the core edit happens once and never grows again.

Do this now, while there is exactly one board command. Doing it after `t3o-03` means refactoring
nine commands' worth of enumeration instead of one.

## The problem

`t3o-02` landed 39 markers across 15 upstream files. Most are fine — a `BoardCardId` added to a union
is a once-only edit. But four seams **enumerate**, and enumeration means the core changes every time
the board grows:

| File | Today | Cost per new command |
| --- | --- | --- |
| `orchestration/decider.ts` | `case "board.card.create":` | +1 case |
| `orchestration/projector.ts` | `case "board.card-created":` | +1 case |
| `Layers/OrchestrationEngine.ts` | `case "board.card.create":` in the aggregate-ref switch | +1 case |
| `Layers/ProjectionPipeline.ts` | `boardCards: BOARD_CARDS_PROJECTOR_NAME` | +1 entry per projector |

`t3o-03` alone adds seven commands and their events. Under the current shape that is roughly a dozen
new core edits, and every spec after it adds more. The seam surface would grow with the feature set —
which is the failure mode this fork's whole strategy exists to avoid.

## The change

Board-owned predicates and registries, exported from `apps/server/src/board/` and
`packages/contracts/src/board.ts`, consumed by the core at a single delegation point each.

### Command decisions — `orchestration/decider.ts`

```ts
// T3o: board commands are decided in the board module. Delegation is by predicate,
// so new board commands never touch this file again.
default:
  if (isBoardCommand(command)) {
    return yield* decideBoardCommand({ command, readModel });
  }
  // ...upstream's existing exhaustiveness handling continues here, unchanged
```

### Event projection — `orchestration/projector.ts`

Same shape, keyed on `isBoardEvent(event)`.

### Aggregate routing — `Layers/OrchestrationEngine.ts`

```ts
// T3o: board commands aggregate on the card (D9).
default:
  if (isBoardCommand(command)) {
    return boardCommandAggregateRef(command);
  }
```

### Projection registry — `Layers/ProjectionPipeline.ts`

Replace the named entry with a spread of a board-owned registry:

```ts
// T3o: board projector names, extended in the board module.
...BOARD_PROJECTOR_NAMES,
```

`makeBoardProjectors(sql)` is already spread — keep it, and make sure the names registry and the
factory are derived from **one** source so they cannot drift.

### Schema unions — `packages/contracts/src/orchestration.ts`

Convert the appended members to spreads of board-owned arrays:

```ts
// T3o: board commands, extended in board.ts.
Schema.Union([...CORE_MEMBERS, ...BOARD_CLIENT_COMMANDS])
Schema.Literals([...CORE_EVENT_TYPES, ...BOARD_EVENT_TYPES])
```

This is the seam that matters most: it is what lets `t3o-03` add seven commands and seven events with
**zero** contract edits.

## The one way this could make things worse

**A bare `default:` destroys upstream's exhaustiveness checking.** Today, if upstream adds a command
and forgets a case, TypeScript errors. A `default:` that swallows everything turns that compile error
into a runtime failure — and we would have made upstream's code *less* safe to maintain a fork of.

So the delegation is **conditional and falls through**:

```ts
default:
  if (isBoardCommand(command)) return /* board */;
  return upstreamsExistingExhaustiveHandler(command);  // absurd / assertNever, unchanged
```

Board-side exhaustiveness moves into `decideBoardCommand`, where it belongs and where we control it.
A board command with no case must be a compile error in **our** module.

This is a hard requirement, not a nicety. Verify it: add a scratch command to the upstream union and
confirm the build still fails.

## What is deliberately not done

- **No plugin registry, no dynamic layer composition, no hook service in upstream code.** That is a
  restructuring diff, and restructuring conflicts far worse than appending in files upstream touches
  79 times in six months. Predicate-delegation is the sweet spot: ~10 lines that never grow.
- **No relocation of `apps/server/src/board/` into a package.** New directories cost nothing —
  upstream will never create a file there, so it cannot conflict. A package would need `apps/server`
  to expose an `exports` map (a core edit to a churning file) and would create a package-level cycle,
  in exchange for zero reduction in seam count.
- **No change to the `BoardCardId` union appends** in `OrchestrationEventStore`,
  `OrchestrationCommandReceipts` and `OrchestrationEngine`. Those are once-only and already generic —
  a second aggregate kind would be one more member, and we are not adding one.

## Verification

- **The count freezes.** Record the marker count before and after in `docs/t3o/seams.md`, and state
  the invariant explicitly: adding a board command, event or projector must now touch **zero**
  upstream files. `t3o-03` is the test of that claim — if it needs a core edit, this spec failed.
- Upstream exhaustiveness still holds: a scratch command added to the core union fails the build.
- Board exhaustiveness holds: a board command with no branch in `decideBoardCommand` fails the build.
- The walking-skeleton tests still pass unchanged — this is a refactor with no behaviour change.
- Re-run the upstream sync runbook afterwards and add a row to the merge log. A seam whose shape just
  changed should be re-proved against real upstream churn.
