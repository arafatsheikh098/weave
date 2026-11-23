# The Weave CRDT

`packages/crdt` is a sequence CRDT for plain text, written from scratch (no Yjs, no Automerge).
This document explains what it stores, how concurrent edits are ordered, why replicas converge,
and what it costs.

## 1. Data model

A document is a list of **items**, one per character ever inserted (tombstones included), kept
in document order. Each item has:

| field | meaning |
|---|---|
| `id = (agent, seq)` | Unique id. `agent` is a random id per editing session; `seq` counts everything that agent has created (0, 1, 2, …). |
| `originLeft` | Id of the item immediately to the left when this one was typed, or `null` for the document start. |
| `originRight` | Id of the item immediately to the right when this one was typed, or `null` for the end. |
| `deleted` | Tombstone flag. Deleted items keep their id and origins but drop their text. |

**Run-length encoding.** Consecutive characters typed by one agent are stored as one *run*
(`agent, seq, len, text`). Character *i* of a run has id `(agent, seq + i)`. Its `originLeft` is
character *i − 1* (or the run's `originLeft` for *i = 0*), and every character in the run shares
the run's `originRight`. Runs are split lazily when an edit lands inside one. A 100,000-keystroke
trace produces about 24,000 runs.

**Operations.**

```
insert(id, text, originLeft, originRight)   consumes text.length sequence numbers
delete(id, ranges: [(agent, seq, len)])     consumes 1 sequence number
```

Because every op consumes sequence numbers, a **version vector** `vv[agent] = number of sequence
numbers seen` completely describes what a replica knows. "Give me what I'm missing" becomes "send
the ops with `seq ≥ vv[agent]`" (`opsSince(vv)`).

## 2. Integration: where does a remote insert go?

To integrate an insert with origins *L* and *R*, scan the items strictly between *L* and *R*.
These are inserts concurrent with ours, or nested inside them. For each scanned item *o*:

```
if o.originLeft is before L:              stop (o belongs to an earlier insertion point)
if o.originLeft is after L (inside range): skip o (it's nested under something we passed)
if o.originLeft == L:
    if o.originRight is before R:          maybe insert after o; keep scanning ("scanning = true")
    if o.originRight == R:                 true conflict: lower agent id goes first;
                                           if we're lower, stop; else skip o
    if o.originRight is after R:           skip o
```

The new item goes at the last position where scanning was not tentative (`dest`). This is the
**YjsMod** rule from Seph Gentle's reference implementations. Weidner & Kleppmann (*The Art of the
Fugue*, 2023) prove it produces exactly the same list order as **FugueMax**. Fugue's key property
is *maximal non-interleaving*:

- **Forward typing:** if Alice types "hello" and Bob types "world" at the same spot concurrently,
  the result is `helloworld` or `worldhello`, never `hweolrllod`.
- **Backward typing:** the same holds when each person types right-to-left (e.g. pressing ← after
  each character), which RGA gets wrong.

Both cases are tested in `test/doc.test.ts`.

Comparisons are cheap because of run-length encoding. Origins are compared via a map of the runs
in the scanned region, and inner characters of a run never change the scan state (their left
origin is the previous character of the same run), so a whole run is treated as one step.

## 3. Why replicas converge

1. **Same set ⇒ same order.** The position of each item depends only on its origins, its id, and
   the items concurrent with it (those between its origins). FugueMax / YjsMod define a single
   total order over any set of items closed under origins, independent of the order in which the
   items were integrated. This is the theorem in the Fugue paper; our implementation follows the
   YjsMod scan exactly.
2. **Causal delivery.** An insert is integrated only after both origins exist and all earlier
   sequence numbers from its agent were seen. A delete is integrated only after its targets exist.
   Ops that arrive early wait in a pending queue; duplicates are dropped (`seq < vv[agent]`).
   Every replica therefore integrates every op exactly once, in some causal order.
3. **Deletes commute.** A delete only sets a flag on existing items, so the order of deletes and
   inserts doesn't matter.

Together: replicas that have received the same set of ops hold identical item lists, and so
identical text.

### Snapshots and state merging

`getState()` serialises the item list (runs, tombstones included) plus the version vector.
`mergeState(state)` lets a replica that edited offline merge a full snapshot when a delta isn't
available (the server only keeps ops since its last snapshot):

- Unknown runs are integrated using their own origins, through a queue so right origins exist
  first.
- Tombstones the replica never saw alive are placed already deleted.
- Deletions in the snapshot are applied.

Local edits the snapshot lacks survive and are then sent as ops. Property tests mix deltas,
snapshots, server restarts and offline clients.

### Garbage collection

Deleted runs drop their text immediately. This is safe because nothing ever needs deleted text:
undo re-inserts from its own copy. Tombstone *items* are kept. Later inserts may use them as
origins, and removing them on only some replicas could change how those replicas order future
concurrent inserts. Safe removal needs *causal stability* (every replica has seen the delete and
will never reference the tombstone again), which a server with offline clients can't know.
The server's snapshots compact the op log instead: ops covered by a snapshot are deleted from
Postgres.

## 4. Anchors and undo

- **Anchors** (`anchorAt`, `resolveAnchor`) store a position as "just after character *id*". A
  collaborator's cursor stays attached to the same character while others edit around it. If that
  character is deleted, the cursor resolves to where the tombstone is.
- **Undo** (`UndoManager`) is per user. Undoing an insert deletes exactly those character ids.
  Undoing a delete re-inserts the text after the anchor where it used to be. Re-inserted
  characters get new ids, so the manager keeps an *old id → new id* redirect, which later
  undo/redo steps follow. Collaborators' edits are never undone.

## 5. Complexity and measurements

With *n* = items (runs) and *k* = concurrent items between a new item's origins:

| operation | cost |
|---|---|
| id → run | O(log n) (per-agent sorted run index) |
| run → index, position → run | O(distance from the last edit), using a locality cache |
| integrate remote insert | O(k) after locating the origins; k is tiny in practice |
| local insert/delete | O(1) amortised for typing at the cursor |
| state encode/decode | O(n) |

Benchmark (`npm run bench`, Apple M-series laptop, Node 25), a synthetic trace of 100,000
keystrokes with realistic locality (12% backspaces, occasional cursor jumps):

| | |
|---|---|
| local edits | 0.40 s (≈ 250,000 keystrokes/s) |
| replay all ops on a fresh replica | 0.15 s |
| load the 2 MB JSON snapshot | 0.28 s |
| two users × 50,000 keystrokes concurrently, then merge | 0.41 s |
| final state | 76,138 characters in 24,172 runs |

## 6. Tests

`packages/crdt/test` has 93 tests:

- **Randomized convergence:** 60 seeds × 2–5 replicas. Random typing and deleting (including
  emoji and accented text), random partial deliveries, out-of-order and duplicated messages, then
  a full sync. All replicas must hold identical text and version vectors and pass internal
  invariant checks.
- **Editor mirror:** a string rebuilt only from change events must equal the document.
- **Snapshot/delta mix:** a server that restarts from snapshots, with clients that go offline.
- **Order independence:** the same ops applied in 20 random orders produce one text.
- **Interleaving:** forward and backward concurrent typing.
- **Undo:** redirects, grouping, never undoing a collaborator's edit.
