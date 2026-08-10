# Multi-server NNTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `@chad3814/nntp` fetch from an ordered list of servers so an article one provider has dropped is retrieved from another.

**Architecture:** `NntpMultiPool` composes one existing `NntpPool` per server and holds only ordering and policy — it manages no sockets. Responses gain an optional `server` name, and the structural `ArticleSource` seam gains an optional `exclude` list, which is how `@chad3814/nzb` (the only layer that sees a yEnc `pcrc32` mismatch) asks for the same article from someone else.

**Tech Stack:** TypeScript 7 composite projects, ESM, Node ≥ 22, vitest 4, oxlint, prettier. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-multi-server-nntp-design.md`

## Global Constraints

- **Never commit without Chad's explicit approval.** CLAUDE.md hard rule 4. Every "Commit" step below means _stage the change and ask_, not `git commit` unprompted.
- **`any` is banned** (lint-enforced). **Non-null assertions are banned** (lint-enforced).
- **Credentials live only in `@chad3814/nntp`** (hard rule 3), and never on an instance field. `packages/nntp/test/client.test.ts` enforces this by scanning every `src/*.ts` for `this.x = credentials` and `this.x = resolveSecret(...)`. New files are covered automatically because the test reads the whole directory.
- **`@chad3814/nzb` must not depend on `@chad3814/nntp`.** It depends on `nzb-parser` and `yenc` only. Shared-looking types are declared separately in each package on purpose; the seam is structural.
- **Prefer async APIs** over their `*Sync` twins (hard rule 5).
- **A change is not done until `npm run check` passes** — typecheck, `oxlint --deny-warnings`, `prettier --check`, and the full vitest run. Run it from `/Users/cwalker/Projects/nzb-utils/worktrees/main`; the shell cwd has repeatedly reset to the bare-repo root, which makes builds silently no-op.
- **Baseline:** 526 tests passing at commit `a5381c3`.
- Every package is at version `1.2.0`, lockstep. Do not bump anything.

## File Structure

| File                                    | Responsibility                                                              |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `packages/nntp/src/models.ts`           | Modify: `server?: string` on `NntpResponse`                                 |
| `packages/nntp/src/pool.ts`             | Modify: attribute responses with the endpoint host                          |
| `packages/nntp/src/errors.ts`           | Modify: add `NntpUnavailableError`                                          |
| `packages/nntp/src/multi-pool.ts`       | Create: `NntpMultiPool`, ordering and policy only                           |
| `packages/nntp/src/index.ts`            | Modify: export the new surface                                              |
| `packages/nntp/test/multi-pool.test.ts` | Create: selection, spillover, auth, thresholds, exhaustion                  |
| `packages/nntp/test/stat-all.test.ts`   | Create: the three-state per-server report                                   |
| `packages/nzb/src/models.ts`            | Modify: widen `ArticleSource`, add `ArticleFetchOptions`                    |
| `packages/nzb/src/fetch.ts`             | Create: fetch-and-decode with CRC retry, shared by the probe and the handle |
| `packages/nzb/src/geometry.ts`          | Modify: route the probe through `fetch.ts`                                  |
| `packages/nzb/src/handle.ts`            | Modify: route `#articleFor` through `fetch.ts`                              |
| `packages/nzb/test/crc-retry.test.ts`   | Create: retry on checksum failure, and the no-`server` no-retry case        |
| `scripts/smoke.ts`                      | Modify: optional `NNTP2_*` second server                                    |
| `packages/nntp/README.md`               | Modify: document the feature                                                |

`fetch.ts` is a new file rather than a method on `Handle` because `geometry.ts` needs the same behaviour for segment 1, and because `handle.ts` is already at the 300-line lint ceiling.

---

### Task 1: Attribute responses with the server that answered

**Files:**

- Modify: `packages/nntp/src/models.ts` (the `NntpResponse` interface, around line 66)
- Modify: `packages/nntp/src/pool.ts` (`body`, `head`, `article`, `stat`, around lines 91–105)
- Test: `packages/nntp/test/pool.test.ts`

**Interfaces:**

- Produces: `NntpResponse.server?: string`. Every later task relies on this being set by `NntpPool` as well as by `NntpMultiPool`, so a caller cannot tell them apart.

- [ ] **Step 1: Write the failing test**

Append to `packages/nntp/test/pool.test.ts`, inside the existing top-level `describe`:

```ts
it('names the server that answered, so a caller can tell pools apart', async () => {
  server = await startFakeServer({ respond: cappedServer(4) });
  pool = new NntpPool({
    endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
    credentials: { user: 'someone', pass: 'secret' },
    connections: 1,
  });

  const response = await pool.body('a@b');

  expect(response.server).toBe('127.0.0.1');
});
```

`pool.test.ts` has no `cappedServer` helper — it lives in `packages/nntp/test/capacity.test.ts` (lines 31–51). Copy it into `pool.test.ts` rather than exporting it across test files. The file already declares `let server: FakeServer | null` and `let pool: NntpPool | null` at module scope and clears both in `afterEach`, so the assignments above narrow correctly and need no extra setup.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/nntp/test/pool.test.ts -t "names the server that answered"`
Expected: FAIL, `expected undefined to be '127.0.0.1'`.

- [ ] **Step 3: Add the field**

In `packages/nntp/src/models.ts`:

```ts
export interface NntpResponse {
  readonly code: number;
  readonly message: string;
  /**
   * Which server answered, for pools that have more than one to choose from.
   *
   * Set by `NntpPool` too, to its endpoint host, so a single pool and an
   * `NntpMultiPool` report identically and a caller retrying elsewhere does
   * not need to know which it holds.
   */
  readonly server?: string;
}
```

- [ ] **Step 4: Attribute in the pool**

In `packages/nntp/src/pool.ts`, replace the four one-line delegating methods. Do **not** write a generic helper that spreads `T` — returning `{ ...response, server }` from a generic function does not typecheck as `T` without a cast, and casts are worse than four small methods.

```ts
  async body(messageId: string): Promise<NntpArticleResponse> {
    const response = await this.#withConnection((client) => client.body(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  async head(messageId: string): Promise<NntpArticleResponse> {
    const response = await this.#withConnection((client) => client.head(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  async article(messageId: string): Promise<NntpArticleResponse> {
    const response = await this.#withConnection((client) => client.article(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  async stat(messageId: string): Promise<NntpResponse> {
    const response = await this.#withConnection((client) => client.stat(messageId));
    return { ...response, server: this.#endpoint.host };
  }
```

- [ ] **Step 5: Run the test and the whole nntp suite**

Run: `npx vitest run packages/nntp`
Expected: PASS, including the new case.

- [ ] **Step 6: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/models.ts packages/nntp/src/pool.ts packages/nntp/test/pool.test.ts
# then ask Chad to approve the commit:
# "Attribute NNTP responses with the server that answered"
```

---

### Task 2: NntpMultiPool construction, validation, status and teardown

**Files:**

- Create: `packages/nntp/src/multi-pool.ts`
- Test: `packages/nntp/test/multi-pool.test.ts`

**Interfaces:**

- Consumes: `NntpPool`, `NntpPoolOptions`, `NntpConnectionFailure` from `./pool.ts`.
- Produces: `NntpMultiPool`, `NntpMultiPoolOptions`, `NntpServerOptions`, `NntpServerStatus`, `ArticleFetchOptions`, and the private `ServerEntry` shape every later task mutates.

- [ ] **Step 1: Write the failing tests**

Create `packages/nntp/test/multi-pool.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

const servers: FakeServer[] = [];
let pool: NntpMultiPool | null = null;

afterEach(async () => {
  pool?.destroy();
  pool = null;
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

/**
 * A fake provider.
 *
 * `logins` is how many AUTHINFO exchanges it accepts before answering 502,
 * which is how a provider reports its simultaneous-connection cap. `has: false`
 * makes it answer 430, which is a retained-article question, not a capacity one.
 */
interface FakeOptions {
  readonly logins?: number;
  readonly has?: boolean;
  readonly refuseAuth?: boolean;
  readonly body?: string;
}

function articleServer(options: FakeOptions = {}): (command: string) => string | null {
  const allowed = options.logins ?? Number.POSITIVE_INFINITY;
  const has = options.has ?? true;
  const payload = options.body ?? 'hello';
  let logins = 0;

  return (command: string): string | null => {
    if (command.startsWith('AUTHINFO')) {
      if (options.refuseAuth === true) {
        return '481 authentication rejected\r\n';
      }
      if (command.startsWith('AUTHINFO PASS')) {
        return '281 authentication accepted\r\n';
      }
      logins += 1;
      return logins > allowed ? '502 Too many connections.\r\n' : '381 password required\r\n';
    }
    if (command.startsWith('BODY') || command.startsWith('ARTICLE') || command.startsWith('HEAD')) {
      return has ? `222 0 <a@b> body follows\r\n${payload}\r\n.\r\n` : '430 No Such Article\r\n';
    }
    if (command.startsWith('STAT')) {
      return has ? '223 0 <a@b>\r\n' : '430 No Such Article\r\n';
    }
    if (command === 'QUIT') {
      return '205 closing\r\n';
    }
    return '500 unknown command\r\n';
  };
}

/** Start a fake provider and return the options that point a pool at it. */
async function provider(
  name: string,
  options: FakeOptions = {},
  extra: Partial<NntpServerOptions> = {},
): Promise<NntpServerOptions> {
  const fake = await startFakeServer({ respond: articleServer(options) });
  servers.push(fake);
  return {
    name,
    endpoint: { host: '127.0.0.1', port: fake.port, security: 'none' },
    credentials: { user: 'someone', pass: 'secret' },
    connections: 2,
    ...extra,
  };
}

describe('NntpMultiPool construction', () => {
  it('reports each server as ready before anything is fetched', async () => {
    pool = new NntpMultiPool({ servers: [await provider('primary'), await provider('backup')] });

    expect(pool.servers.map((entry) => entry.name)).toEqual(['primary', 'backup']);
    expect(pool.servers.every((entry) => entry.state === 'ready')).toBe(true);
    expect(pool.servers.every((entry) => entry.downReason === null)).toBe(true);
  });

  it('defaults a name to the host', async () => {
    const first = await provider('ignored');
    const { name: _drop, ...unnamed } = first;
    pool = new NntpMultiPool({ servers: [unnamed] });

    expect(pool.servers[0]?.name).toBe('127.0.0.1');
  });

  it('rejects duplicate names, because exclusion is by name', async () => {
    // Two servers called the same thing would make one exclusion remove both,
    // silently turning a CRC retry into "no candidates left".
    const first = await provider('same');
    const second = await provider('same');

    expect(() => new NntpMultiPool({ servers: [first, second] })).toThrow(/duplicate/u);
  });

  it('rejects an empty server list', () => {
    expect(() => new NntpMultiPool({ servers: [] })).toThrow(/at least one/u);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts`
Expected: FAIL — `Cannot find module '../src/multi-pool.ts'`.

- [ ] **Step 3: Create the module**

Create `packages/nntp/src/multi-pool.ts`:

```ts
import { NntpPool } from './pool.ts';
import type { NntpConnectionFailure, NntpPoolOptions } from './pool.ts';

/**
 * One server in an ordered list.
 *
 * Extends {@link NntpPoolOptions} so a server is configured exactly as a single
 * pool is today — same endpoint, credentials, connection count and timeouts.
 */
export interface NntpServerOptions extends NntpPoolOptions {
  /** Stable name for failure reports and exclusions. Defaults to the host. */
  readonly name?: string;
  /**
   * May this server take work an earlier one could have served, when that one
   * is at its connection cap?
   *
   * Defaults to false. A metered block account should pay for gaps, not for
   * overflow the primary would have covered a moment later.
   */
  readonly spillover?: boolean;
}

export interface NntpMultiPoolOptions {
  /** Tried in order. The first is the primary. */
  readonly servers: readonly NntpServerOptions[];
}

/** Narrowing a request away from servers already tried for this article. */
export interface ArticleFetchOptions {
  /** Server names already tried. */
  readonly exclude?: readonly string[];
}

export interface NntpServerStatus {
  readonly name: string;
  readonly state: 'ready' | 'down';
  /** Why it went down. Null while ready. */
  readonly downReason: Error | null;
  /** Learned connection limit, which may be below the configured one. */
  readonly limit: number;
  readonly failures: readonly NntpConnectionFailure[];
}

/** Mutable per-server state. Deliberately holds no credential — see below. */
interface ServerEntry {
  readonly name: string;
  readonly spillover: boolean;
  readonly pool: NntpPool;
  state: 'ready' | 'down';
  downReason: Error | null;
  consecutiveFailures: number;
}

/**
 * An ordered list of servers, tried in turn.
 *
 * The purpose is filling gaps, not aggregating bandwidth: a later server is
 * reached only when an earlier one cannot supply the article. That is why
 * candidates are tried sequentially, and why taking overflow from a saturated
 * server is opt-in per server.
 *
 * Composes one {@link NntpPool} per server rather than teaching one pool about
 * several endpoints, because the learned connection cap, the credential and the
 * up/down state are all per-server. This class manages no sockets.
 */
export class NntpMultiPool {
  readonly #servers: ServerEntry[];

  constructor(options: NntpMultiPoolOptions) {
    if (options.servers.length === 0) {
      throw new TypeError('NntpMultiPool needs at least one server');
    }

    const seen = new Set<string>();
    // Destructured, not retained: `options.servers` entries carry `credentials`,
    // and keeping one on a field would put a credential -- or a provider closure
    // -- on an instance, which hard rule 3 forbids and client.test.ts scans for.
    // The credential ends up only inside its own pool's memoized providers.
    this.#servers = options.servers.map((server): ServerEntry => {
      const name = server.name ?? server.endpoint.host;
      if (seen.has(name)) {
        throw new TypeError(
          `duplicate server name ${JSON.stringify(name)}; names must be unique because exclusions are by name`,
        );
      }
      seen.add(name);

      return {
        name,
        spillover: server.spillover ?? false,
        pool: new NntpPool(server),
        state: 'ready',
        downReason: null,
        consecutiveFailures: 0,
      };
    });
  }

  get servers(): readonly NntpServerStatus[] {
    return this.#servers.map((entry) => ({
      name: entry.name,
      state: entry.state,
      downReason: entry.downReason,
      limit: entry.pool.limit,
      failures: entry.pool.failures,
    }));
  }

  destroy(): void {
    for (const entry of this.#servers) {
      entry.pool.destroy();
    }
  }
}
```

A `TypeError` rather than one of the `Nntp*Error` classes: these are programmer errors in configuration, not protocol conditions, and the existing error types all carry a status code that would be meaningless here.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/multi-pool.ts packages/nntp/test/multi-pool.test.ts
# "Add NntpMultiPool construction, status and teardown"
```

---

### Task 3: Sequential selection, 430 fallback, and `exclude`

**Files:**

- Modify: `packages/nntp/src/multi-pool.ts`
- Test: `packages/nntp/test/multi-pool.test.ts`

**Interfaces:**

- Produces: `body`, `head`, `article`, `stat` on `NntpMultiPool`, each accepting `ArticleFetchOptions`; and the private `#run` used by Tasks 4–6.

- [ ] **Step 1: Write the failing tests**

Append to `packages/nntp/test/multi-pool.test.ts`:

```ts
describe('NntpMultiPool selection', () => {
  it('never contacts the backup when the primary has the article', async () => {
    // The assertion that protects a metered account, and the first casualty of
    // any "make it faster by asking everyone at once" change.
    pool = new NntpMultiPool({
      servers: [await provider('primary'), await provider('backup')],
    });

    await pool.body('a@b');

    const backup = servers[1];
    expect(backup?.commands).toEqual([]);
  });

  it('falls back to the next server on a 430', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('backup')],
    });

    const response = await pool.body('a@b');

    expect(response.server).toBe('backup');
    expect(response.body.toString('latin1')).toBe('hello\r\n');
  });

  it('skips a server named in exclude', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary'), await provider('backup')],
    });

    const response = await pool.body('a@b', { exclude: ['primary'] });

    expect(response.server).toBe('backup');
    expect(servers[0]?.commands.some((command) => command.startsWith('BODY'))).toBe(false);
  });

  it('attributes the response even when the primary served it', async () => {
    pool = new NntpMultiPool({ servers: [await provider('primary'), await provider('backup')] });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'primary' });
  });

  it('applies the same walk to stat', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('backup')],
    });

    await expect(pool.stat('a@b')).resolves.toMatchObject({ code: 223, server: 'backup' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts -t "selection"`
Expected: FAIL — `pool.body is not a function`.

- [ ] **Step 3: Implement selection**

Add to `packages/nntp/src/multi-pool.ts`. Import what you need at the top:

```ts
import { NntpProtocolError } from './errors.ts';
import type { NntpArticleResponse, NntpResponse } from './models.ts';
```

Add to the class:

```ts
  async body(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse> {
    const { response, server } = await this.#run(options, async (pool) => pool.body(messageId));
    return { ...response, server };
  }

  async head(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse> {
    const { response, server } = await this.#run(options, async (pool) => pool.head(messageId));
    return { ...response, server };
  }

  async article(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse> {
    const { response, server } = await this.#run(options, async (pool) => pool.article(messageId));
    return { ...response, server };
  }

  async stat(messageId: string, options?: ArticleFetchOptions): Promise<NntpResponse> {
    const { response, server } = await this.#run(options, async (pool) => pool.stat(messageId));
    return { ...response, server };
  }

  /**
   * Walk the candidates in order until one answers.
   *
   * Returns the raw response alongside the name rather than merging them here:
   * spreading a generic `T` does not typecheck as `T`, and each caller knows its
   * own concrete response type.
   */
  async #run<T extends NntpResponse>(
    options: ArticleFetchOptions | undefined,
    call: (pool: NntpPool) => Promise<T>,
  ): Promise<{ response: T; server: string }> {
    const excluded = new Set(options?.exclude ?? []);

    for (const entry of this.#servers) {
      if (entry.state === 'down' || excluded.has(entry.name)) {
        continue;
      }

      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential is the point:
        // asking every server at once would spend backup bytes on every article
        const response = await call(entry.pool);
        entry.consecutiveFailures = 0;
        return { response, server: entry.name };
      } catch (error) {
        if (error instanceof NntpProtocolError && error.code === 430) {
          // A gap, not a fault: this server does not have this article, which
          // says nothing about its health.
          continue;
        }
        throw error;
      }
    }

    throw new NntpProtocolError(430, 'No Such Article on any configured server');
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/multi-pool.ts packages/nntp/test/multi-pool.test.ts
# "Walk servers in order, falling back on a 430"
```

---

### Task 4: Capacity and the spillover gate

**Files:**

- Modify: `packages/nntp/src/multi-pool.ts` (`#run`)
- Test: `packages/nntp/test/multi-pool.test.ts`

**Interfaces:**

- Consumes: `#run` from Task 3, `NntpCapacityError` from `./errors.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/nntp/test/multi-pool.test.ts`:

```ts
describe('NntpMultiPool at a connection cap', () => {
  it('does not spill onto a server that has not opted in', async () => {
    // logins: 0 means the primary can open nothing at all, which is the only
    // case where NntpCapacityError escapes the pool -- a partial cap is
    // absorbed by the pool shrinking its limit and queueing.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { logins: 0 }), await provider('block')],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpCapacityError);
    expect(servers[1]?.commands).toEqual([]);
  });

  it('spills onto a server that has opted in', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { logins: 0 }),
        await provider('second', {}, { spillover: true }),
      ],
    });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'second' });
  });

  it('still falls back to a non-spillover server for a genuine gap', async () => {
    // The flag gates overflow only. A 430 is a gap, and that is what the
    // backup is for.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('block')],
    });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'block' });
  });
});
```

Add `NntpCapacityError` to the imports at the top of the test file:

```ts
import { NntpCapacityError } from '../src/errors.ts';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts -t "connection cap"`
Expected: FAIL — the first case rejects, but the backup was contacted, so `commands` is not empty.

- [ ] **Step 3: Add the gate**

In `#run`, add a sticky flag and a capacity branch:

```ts
    const excluded = new Set(options?.exclude ?? []);
    // Sticky: once a server has been skipped because it was full, everything
    // after it is serving overflow rather than filling a gap, and overflow is
    // opt-in.
    let requireSpillover = false;

    for (const entry of this.#servers) {
      if (entry.state === 'down' || excluded.has(entry.name)) {
        continue;
      }
      if (requireSpillover && !entry.spillover) {
        continue;
      }
      // ...
```

and inside the `catch`, before the 430 branch:

```ts
if (error instanceof NntpCapacityError) {
  // Only reaches here when the pool could open no connection at all; a
  // partial cap is absorbed by the pool shrinking and queueing.
  requireSpillover = true;
  lastCapacityError = error;
  continue;
}
```

Declare `let lastCapacityError: NntpCapacityError | null = null;` beside `requireSpillover`, and at the end of the walk, before the 430 throw:

```ts
if (lastCapacityError !== null) {
  throw lastCapacityError;
}
```

Import it: `import { NntpCapacityError, NntpProtocolError } from './errors.ts';`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/multi-pool.ts packages/nntp/test/multi-pool.test.ts
# "Gate capacity spillover behind a per-server opt-in"
```

---

### Task 5: Auth handling and the failure threshold

**Files:**

- Modify: `packages/nntp/src/multi-pool.ts`
- Test: `packages/nntp/test/multi-pool.test.ts`

**Interfaces:**

- Produces: `#markDown(entry, reason)`, the `#fatal` state, and `DOWN_AFTER`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/nntp/test/multi-pool.test.ts`:

```ts
describe('NntpMultiPool with a bad server', () => {
  it('treats an auth failure on the primary as fatal and never uses a backup', async () => {
    // Failing over here would quietly run a whole download on a metered
    // account because the primary's password was mistyped.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { refuseAuth: true }), await provider('backup')],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpAuthError);
    expect(servers[1]?.commands).toEqual([]);
  });

  it('keeps the primary auth failure sticky', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary', { refuseAuth: true }), await provider('backup')],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpAuthError);
    await expect(pool.body('b@b')).rejects.toBeInstanceOf(NntpAuthError);
    expect(servers[1]?.commands).toEqual([]);
  });

  it('marks a backup down on its first auth failure and stops asking it', async () => {
    // Deterministic: a password that was wrong a moment ago will be wrong
    // again, so retrying it once per article is pure noise.
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('bad', { refuseAuth: true }),
        await provider('good'),
      ],
    });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'good' });
    const afterFirst = servers[1]?.commands.length ?? 0;

    await expect(pool.body('b@b')).resolves.toMatchObject({ server: 'good' });

    expect(servers[1]?.commands.length).toBe(afterFirst);
    expect(pool.servers[1]?.state).toBe('down');
    expect(pool.servers[1]?.downReason).toBeInstanceOf(NntpAuthError);
  });

  it('leaves a server up when its failures are not consecutive', async () => {
    // A fake that accepts the connection and then refuses every command with a
    // 400 forces the pool to discard the connection and the multi-pool to count
    // a connection-level failure.
    let refusals = 0;
    const flaky = await startFakeServer({
      respond: (command) => {
        if (command.startsWith('AUTHINFO PASS')) return '281 authentication accepted\r\n';
        if (command.startsWith('AUTHINFO')) return '381 password required\r\n';
        if (command.startsWith('BODY')) {
          refusals += 1;
          return refusals === 3
            ? '222 0 <a@b> body follows\r\nhello\r\n.\r\n'
            : '400 unavailable\r\n';
        }
        return '500 unknown command\r\n';
      },
    });
    servers.push(flaky);

    pool = new NntpMultiPool({
      servers: [
        {
          name: 'flaky',
          endpoint: { host: '127.0.0.1', port: flaky.port, security: 'none' },
          credentials: { user: 'someone', pass: 'secret' },
          connections: 1,
        },
        await provider('backup'),
      ],
    });

    await pool.body('a@b'); // flaky fails once, backup serves
    await pool.body('b@b'); // twice
    await pool.body('c@b'); // third call succeeds on flaky, resetting the count

    expect(pool.servers[0]?.state).toBe('ready');
  });
});
```

Add to the test file's imports:

```ts
import { NntpAuthError } from '../src/errors.ts';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts -t "bad server"`
Expected: FAIL — the auth error propagates but the backup is contacted, and `state` is never `'down'`.

- [ ] **Step 3: Implement**

Add near the top of `multi-pool.ts`:

```ts
/**
 * Consecutive connection-level failures before a server leaves the rotation.
 *
 * Three, not one: a timeout on a single article is a bad moment, not a dead
 * provider. An auth failure bypasses this entirely -- it is deterministic.
 */
const DOWN_AFTER = 3;
```

Add the field and helper to the class:

```ts
  /** Set when the primary cannot authenticate. Sticky, and rethrown to everyone. */
  #fatal: Error | null = null;
```

```ts
  #markDown(entry: ServerEntry, reason: Error): void {
    entry.state = 'down';
    entry.downReason = reason;
  }
```

At the top of `#run`:

```ts
if (this.#fatal !== null) {
  throw this.#fatal;
}
```

And in the `catch`, after the capacity branch and before the 430 branch:

```ts
if (error instanceof NntpAuthError) {
  if (entry === this.#servers[0]) {
    // The server you always use must be right. Failing over would run
    // the whole job on a backup because of a typo.
    this.#fatal = error;
    throw error;
  }
  // A backup that cannot log in is treated like one that is
  // unreachable, so a stale token does not abort a nearly-finished
  // download. One strike, because the outcome is deterministic.
  this.#markDown(entry, error);
  continue;
}
```

and replace the final `throw error;` in the catch with the connection-failure path:

```ts
// Timeout, connection loss, or an unexpected status: transient until it
// is not, so count it and move on.
const reason = error instanceof Error ? error : new Error(String(error));
entry.consecutiveFailures += 1;
if (entry.consecutiveFailures >= DOWN_AFTER) {
  this.#markDown(entry, reason);
}
continue;
```

Import `NntpAuthError` alongside the others.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/multi-pool.ts packages/nntp/test/multi-pool.test.ts
# "Fail fast on primary auth, mark bad backups down"
```

---

### Task 6: Exhaustion — unanimous 430 versus a mixed failure

**Files:**

- Modify: `packages/nntp/src/errors.ts`
- Modify: `packages/nntp/src/multi-pool.ts`
- Test: `packages/nntp/test/multi-pool.test.ts`

**Interfaces:**

- Produces: `NntpUnavailableError` with `readonly attempts: readonly NntpServerAttempt[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/nntp/test/multi-pool.test.ts`:

```ts
describe('NntpMultiPool when no server can supply the article', () => {
  it('throws a 430 when every server said 430', async () => {
    // nzb get depends on this error type to skip a file and carry on -- it is
    // how a run survives an expired .nfo. A new error type here would turn a
    // skip into a crash.
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('backup', { has: false }),
      ],
    });

    const error = await pool.body('a@b').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NntpProtocolError);
    expect((error as NntpProtocolError).code).toBe(430);
  });

  it('throws NntpUnavailableError naming each server on a mixed failure', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('gone', { has: false }),
        await provider('broken', { refuseAuth: true }),
      ],
    });

    const error = await pool.body('a@b').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NntpUnavailableError);
    expect((error as NntpUnavailableError).attempts.map((attempt) => attempt.server)).toEqual([
      'gone',
      'broken',
    ]);
    expect((error as NntpUnavailableError).message).toContain('broken');
  });

  it('throws NntpUnavailableError when every candidate was excluded', async () => {
    pool = new NntpMultiPool({ servers: [await provider('only')] });

    await expect(pool.body('a@b', { exclude: ['only'] })).rejects.toBeInstanceOf(
      NntpUnavailableError,
    );
  });
});
```

Add to the test imports:

```ts
import { NntpProtocolError, NntpUnavailableError } from '../src/errors.ts';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts -t "no server can supply"`
Expected: FAIL — `NntpUnavailableError` is not exported.

- [ ] **Step 3: Add the error**

Append to `packages/nntp/src/errors.ts`:

```ts
/** One server's answer when a request had to walk the whole list. */
export interface NntpServerAttempt {
  readonly server: string;
  readonly reason: Error;
}

/**
 * No configured server could supply the article, and they did not all agree
 * why.
 *
 * When every server answers 430 the article is simply gone, and a 430
 * `NntpProtocolError` is thrown instead — callers already treat that as "skip
 * this file and report it", and widening the type would turn a skip into a
 * crash. This error is for the mixed case, where at least one server could not
 * be asked, and it keeps every server's reason so the report can name them.
 */
export class NntpUnavailableError extends Error {
  readonly attempts: readonly NntpServerAttempt[];

  constructor(attempts: readonly NntpServerAttempt[]) {
    const detail =
      attempts.length === 0
        ? 'no server was available to try'
        : attempts.map((attempt) => `${attempt.server}: ${attempt.reason.message}`).join('; ');
    super(`no configured server could supply the article (${detail})`);
    this.name = 'NntpUnavailableError';
    this.attempts = attempts;
  }
}
```

- [ ] **Step 4: Record attempts and choose the error**

In `#run`, declare `const attempts: NntpServerAttempt[] = [];` alongside `requireSpillover`, and push in every `catch` branch before `continue` (including the 430 branch):

```ts
const reason = error instanceof Error ? error : new Error(String(error));
attempts.push({ server: entry.name, reason });
```

Move that pair to the top of the `catch`, ahead of the existing branches, and use `reason` in place of the later re-derivation.

Replace the tail of `#run`:

```ts
if (lastCapacityError !== null) {
  throw lastCapacityError;
}

const allGone =
  attempts.length > 0 &&
  attempts.every(
    (attempt) => attempt.reason instanceof NntpProtocolError && attempt.reason.code === 430,
  );
throw allGone
  ? new NntpProtocolError(430, 'No Such Article on any configured server')
  : new NntpUnavailableError(attempts);
```

Import `NntpUnavailableError` and the `NntpServerAttempt` type.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 6: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/errors.ts packages/nntp/src/multi-pool.ts packages/nntp/test/multi-pool.test.ts
# "Distinguish gone-everywhere from a mixed multi-server failure"
```

---

### Task 7: `statAll`

**Files:**

- Modify: `packages/nntp/src/multi-pool.ts`
- Test: `packages/nntp/test/stat-all.test.ts`

**Interfaces:**

- Produces: `NntpServerStat` and `statAll(messageId)`.

- [ ] **Step 1: Write the failing test**

Create `packages/nntp/test/stat-all.test.ts`. Copy the `articleServer`, `provider`, `servers` and `afterEach` scaffolding from `multi-pool.test.ts` verbatim — it is fixture setup, and duplicating it keeps each file readable on its own.

```ts
describe('statAll', () => {
  it('separates absent from unknown, which one server cannot', async () => {
    // stat throws on a 430 today, so "does not have it" and "could not ask"
    // are both errors. Across servers that is the difference between gone
    // everywhere and gone from the ones that answered -- and only the first
    // justifies giving up on a file.
    const unreachable = await provider('unreachable', { refuseAuth: true });
    pool = new NntpMultiPool({
      servers: [await provider('has-it'), await provider('lost-it', { has: false }), unreachable],
    });

    const report = await pool.statAll('a@b');

    expect(report).toEqual([
      { server: 'has-it', status: 'present' },
      { server: 'lost-it', status: 'absent' },
      { server: 'unreachable', status: 'unknown', reason: expect.any(Error) },
    ]);
  });

  it('reports a server already marked down as unknown, with its reason', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('bad', { refuseAuth: true }),
        await provider('good'),
      ],
    });

    await pool.body('a@b'); // marks 'bad' down
    const report = await pool.statAll('a@b');

    expect(report[1]).toMatchObject({ server: 'bad', status: 'unknown' });
  });

  it('does not mark a server down as a side effect of reporting', async () => {
    // statAll is diagnostic. A report that changes what it reports on is a
    // trap.
    pool = new NntpMultiPool({ servers: [await provider('flaky', { refuseAuth: true })] });

    await pool.statAll('a@b');
    await pool.statAll('a@b');

    expect(pool.servers[0]?.state).toBe('ready');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/nntp/test/stat-all.test.ts`
Expected: FAIL — `pool.statAll is not a function`.

- [ ] **Step 3: Implement**

Add the type beside `NntpServerStatus` in `multi-pool.ts`:

```ts
/**
 * One server's answer about one article.
 *
 * Three states, not two: `absent` is the server saying it does not have the
 * article, `unknown` is not having been able to ask. Collapsing them loses the
 * only distinction that matters when deciding whether a file is really gone.
 */
export type NntpServerStat = { readonly server: string } & (
  | { readonly status: 'present' }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: Error }
);
```

And the method:

```ts
  /**
   * Ask every server whether it has the article.
   *
   * Concurrent, because STAT transfers no body: it costs a round trip and no
   * meaningful bytes, so it is not gated by {@link NntpServerOptions.spillover}
   * the way a download is. Purely diagnostic — it never marks a server down and
   * never counts toward the failure threshold.
   */
  async statAll(messageId: string): Promise<readonly NntpServerStat[]> {
    if (this.#fatal !== null) {
      throw this.#fatal;
    }

    return Promise.all(
      this.#servers.map(async (entry): Promise<NntpServerStat> => {
        if (entry.state === 'down') {
          return {
            server: entry.name,
            status: 'unknown',
            reason: entry.downReason ?? new NntpConnectionError(`${entry.name} is marked down`),
          };
        }

        try {
          await entry.pool.stat(messageId);
          return { server: entry.name, status: 'present' };
        } catch (error) {
          if (error instanceof NntpProtocolError && error.code === 430) {
            return { server: entry.name, status: 'absent' };
          }
          return {
            server: entry.name,
            status: 'unknown',
            reason: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }),
    );
  }
```

Import `NntpConnectionError`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/nntp/test/stat-all.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/multi-pool.ts packages/nntp/test/stat-all.test.ts
# "Add statAll for per-server retention"
```

---

### Task 8: Exports, credential coverage, README

**Files:**

- Modify: `packages/nntp/src/index.ts`
- Modify: `packages/nntp/README.md`
- Test: `packages/nntp/test/multi-pool.test.ts`

**Interfaces:**

- Produces: the public surface consumers import.

- [ ] **Step 1: Write the failing test**

Append to `packages/nntp/test/multi-pool.test.ts`:

```ts
it('keeps no credential on the multi-pool itself', async () => {
  // Hard rule 3. The source-level scan in client.test.ts covers assignments;
  // this covers the shape that would defeat it -- retaining the whole options
  // object, credentials and all.
  pool = new NntpMultiPool({ servers: [await provider('primary')] });

  expect(inspect(pool, { showHidden: true, depth: 6 })).not.toContain('secret');
});
```

Add `import { inspect } from 'node:util';` to the test file.

- [ ] **Step 2: Run it**

Run: `npx vitest run packages/nntp/test/multi-pool.test.ts -t "keeps no credential"`
Expected: PASS if Task 2's constructor destructured correctly. **If it fails, that is a real bug** — the constructor is retaining `options.servers`. Fix the constructor, not the test.

- [ ] **Step 3: Export the surface**

In `packages/nntp/src/index.ts`:

```ts
export { NntpMultiPool } from './multi-pool.ts';
export type {
  ArticleFetchOptions,
  NntpMultiPoolOptions,
  NntpServerOptions,
  NntpServerStat,
  NntpServerStatus,
} from './multi-pool.ts';
```

and add `NntpUnavailableError` to the existing `./errors.ts` export block, plus `NntpServerAttempt` to a type export from `./errors.ts`.

- [ ] **Step 4: Document it**

In `packages/nntp/README.md`, add a section after "At a provider's connection cap":

````markdown
## More than one server

An article one provider has dropped is often still on another. `NntpMultiPool`
takes an ordered list and reaches a later server only when an earlier one cannot
supply the article — filling gaps, not aggregating bandwidth.

```ts
const pool = new NntpMultiPool({
  servers: [
    { name: 'primary', endpoint, credentials, connections: 20 },
    { name: 'block', endpoint: other, credentials: blockCreds, connections: 8 },
  ],
});

const { body, server } = await pool.body('abc123@news.example.com');
```

Servers are tried **sequentially**. Asking all of them at once would spend
backup bytes on every article, which is exactly what a metered block account
must not do. For the same reason, taking overflow from a server that is at its
connection cap is opt-in per server via `spillover`, and off by default.

| Outcome                                 | What happens                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `430`                                   | A gap. Advance to the next server.                                                                         |
| Timeout or connection loss              | Counted. Three in a row with no success between takes the server out of rotation for the life of the pool. |
| At the connection cap, nothing openable | Advance only to servers with `spillover: true`.                                                            |
| Auth refused on the primary             | Fatal, and sticky. Failing over would run a whole download on a backup because of a typo.                  |
| Auth refused on any other server        | That server is marked down immediately — a wrong password will still be wrong next time.                   |

If every server answers `430`, the article is gone and a `430`
`NntpProtocolError` is thrown, so callers that skip-and-report keep working. Any
other mixture throws `NntpUnavailableError`, whose `attempts` names each server
and its reason.

`statAll(messageId)` reports per server, with three states rather than two:
`present`, `absent` (the server said 430) and `unknown` (it could not be asked).
That distinction is the difference between _gone everywhere_ and _gone from the
ones that answered_, and only the first justifies giving up on a file.
````

- [ ] **Step 5: Full check, then stage and ask**

```bash
npm run check
git add packages/nntp/src/index.ts packages/nntp/README.md packages/nntp/test/multi-pool.test.ts
# "Export the multi-server surface and document it"
```

---

### Task 9: Widen the `ArticleSource` seam and retry a bad CRC

**Files:**

- Modify: `packages/nzb/src/models.ts`
- Create: `packages/nzb/src/fetch.ts`
- Modify: `packages/nzb/src/geometry.ts:58-59`
- Modify: `packages/nzb/src/handle.ts` (`#articleFor`, around lines 260–278)
- Modify: `packages/nzb/src/index.ts`
- Test: `packages/nzb/test/crc-retry.test.ts`

**Interfaces:**

- Consumes: nothing from `@chad3814/nntp` — the seam is structural and `nzb` must not depend on the transport.
- Produces: `fetchArticle(source, messageId, options)` returning `YencArticle`.

- [ ] **Step 1: Write the failing tests**

Create `packages/nzb/test/crc-retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { fetchArticle } from '../src/fetch.ts';
import type { ArticleBody, ArticleFetchOptions, ArticleSource } from '../src/models.ts';
import { buildPost } from './post.ts';

/**
 * The fixture's raw article bytes for segment 1, plus a copy whose payload has
 * been altered so the `=yend pcrc32` no longer describes it.
 *
 * `Post` is `{ file, source, data }` — there is no map of articles on it, so
 * the encoded bytes come back through the source itself.
 *
 * One payload byte is set to a specific safe value rather than XORed: an
 * arbitrary flip can produce `=`, CR or LF, which changes the article's
 * *structure* and raises YencDecodeError instead of the checksum error this is
 * meant to provoke.
 */
async function corruptible(): Promise<{ id: string; good: Buffer; corrupt: Buffer }> {
  const post = buildPost({ segmentSizes: [100] });
  const id = post.file.segments[0]?.messageId;
  if (id === undefined) {
    throw new Error('fixture has no segments');
  }

  const { body: good } = await post.source.body(id);
  const corrupt = Buffer.from(good);
  // First byte after the =ybegin line. A single-segment post has no =ypart, so
  // the payload starts immediately.
  const at = good.indexOf('\r\n') + 2;
  const original = corrupt[at];
  if (original === undefined) {
    throw new Error('fixture article is shorter than its header');
  }
  corrupt[at] = original === 0x41 ? 0x42 : 0x41;

  return { id, good, corrupt };
}

/** A source where the server named `bad` serves the corrupted copy. */
function twoServers(good: Buffer, corrupt: Buffer): ArticleSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    body(_messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody> {
      const excluded = new Set(options?.exclude ?? []);
      const server = excluded.has('bad') ? 'good' : 'bad';
      asked.push(server);
      return Promise.resolve({ body: server === 'bad' ? corrupt : good, server });
    },
  };
}

describe('fetchArticle', () => {
  it('retries on another server when the CRC does not match', async () => {
    const { id, good, corrupt } = await corruptible();
    const source = twoServers(good, corrupt);

    const article = await fetchArticle(source, id, { verify: true });

    expect(source.asked).toEqual(['bad', 'good']);
    expect(article.data.byteLength).toBe(100);
  });

  it('does not retry when the source names no server', async () => {
    // A plain NntpPool or a test double. Nothing to exclude, so behaviour is
    // exactly what it was before multi-server existed: the error propagates.
    const { id, corrupt } = await corruptible();
    let calls = 0;
    const source: ArticleSource = {
      body: () => {
        calls += 1;
        return Promise.resolve({ body: corrupt });
      },
    };

    await expect(fetchArticle(source, id, { verify: true })).rejects.toBeInstanceOf(
      YencChecksumError,
    );
    expect(calls).toBe(1);
  });

  it('does not loop when a source ignores exclude', async () => {
    const { id, corrupt } = await corruptible();
    let calls = 0;
    const source: ArticleSource = {
      body: () => {
        calls += 1;
        return Promise.resolve({ body: corrupt, server: 'stubborn' });
      },
    };

    await expect(fetchArticle(source, id, { verify: true })).rejects.toBeInstanceOf(
      YencChecksumError,
    );
    expect(calls).toBe(2);
  });

  it('does not retry a malformed article, which is malformed everywhere', async () => {
    const source: ArticleSource = {
      body: () => Promise.resolve({ body: Buffer.from('not yEnc at all\r\n'), server: 'a' }),
    };

    await expect(fetchArticle(source, 'x@y', { verify: true })).rejects.toBeInstanceOf(
      YencDecodeError,
    );
  });
});
```

Add to the test file's imports:

```ts
import { YencChecksumError, YencDecodeError } from '@chad3814/yenc';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/nzb/test/crc-retry.test.ts`
Expected: FAIL — `Cannot find module '../src/fetch.ts'`.

- [ ] **Step 3: Widen the seam**

In `packages/nzb/src/models.ts`:

```ts
/**
 * Narrowing a request away from sources already tried for this article.
 *
 * Declared here rather than imported from `@chad3814/nntp`: this package
 * depends on `nzb-parser` and `yenc` and nothing else, and the seam is
 * structural on purpose so a cache or a fixture can satisfy it without taking a
 * dependency on the transport.
 */
export interface ArticleFetchOptions {
  /** Names of sources already tried, from {@link ArticleBody.server}. */
  readonly exclude?: readonly string[];
}

export interface ArticleBody {
  readonly body: Buffer;
  /** Which server supplied this, for sources that have more than one. */
  readonly server?: string;
}

export interface ArticleSource {
  body(messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody>;
}
```

- [ ] **Step 4: Add the shared fetch**

Create `packages/nzb/src/fetch.ts`:

```ts
import { decodeArticle, YencChecksumError } from '@chad3814/yenc';
import type { YencArticle } from '@chad3814/yenc';

import type { ArticleSource } from './models.ts';

export interface FetchArticleOptions {
  /** Check the article against the CRC32 in its own `=yend` trailer. */
  readonly verify: boolean;
}

/**
 * Fetch one article and decode it, trying another server if the CRC fails.
 *
 * A `pcrc32` mismatch means the bytes are wrong, and another provider is the
 * only fix — which is why this lives here rather than in the transport: yEnc
 * is decoded above it, so the pool cannot see the failure.
 *
 * It needs no retry counter. Each attempt adds the serving source to the
 * exclusion list, so a multi-server source runs out of candidates and throws.
 * Two guards cover sources that are not multi-server: one that reports no
 * server has nothing to exclude, and one that ignores the exclusion is stopped
 * the moment it repeats itself.
 */
export async function fetchArticle(
  source: ArticleSource,
  messageId: string,
  options: FetchArticleOptions,
): Promise<YencArticle> {
  const tried: string[] = [];

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt depends on the last
    const response = await source.body(
      messageId,
      tried.length === 0 ? undefined : { exclude: tried },
    );

    try {
      return decodeArticle(response.body, { verify: options.verify });
    } catch (error) {
      const { server } = response;
      // Only a checksum failure is worth another server. A malformed article is
      // malformed everywhere, and retrying it just spends someone's bytes.
      if (!(error instanceof YencChecksumError) || server === undefined || tried.includes(server)) {
        throw error;
      }
      tried.push(server);
    }
  }
}
```

- [ ] **Step 5: Route both callers through it**

In `packages/nzb/src/geometry.ts`, replace lines 58–59:

```ts
const article = await fetchArticle(source, first.messageId, { verify: options.verify ?? true });
```

and drop the now-unused `decodeArticle` import if nothing else in the file uses it.

In `packages/nzb/src/handle.ts`, in `#articleFor`:

```ts
const article =
  number === 1
    ? context.first
    : await fetchArticle(context.source, segment.messageId, { verify: context.verify });
```

and replace the `decodeArticle` import with `import { fetchArticle } from './fetch.ts';` if nothing else needs it.

Export the new types from `packages/nzb/src/index.ts`: add `ArticleFetchOptions` to the type export block from `./models.ts`, and `export { fetchArticle } from './fetch.ts';` with `export type { FetchArticleOptions } from './fetch.ts';`.

- [ ] **Step 6: Run the nzb suite**

Run: `npx vitest run packages/nzb`
Expected: PASS. The existing 200-odd nzb tests must be untouched — every fixture source omits `server`, so nothing retries.

- [ ] **Step 7: Full check, then stage and ask**

```bash
npm run check
git add packages/nzb/src/models.ts packages/nzb/src/fetch.ts packages/nzb/src/geometry.ts \
  packages/nzb/src/handle.ts packages/nzb/src/index.ts packages/nzb/test/crc-retry.test.ts
# "Retry a failed CRC on another server"
```

---

### Task 10: A second live server in the smoke test

**Files:**

- Modify: `scripts/smoke.ts`

**Interfaces:**

- Consumes: `NntpMultiPool` from Task 8's exports, `fetchArticle` from Task 9.

- [ ] **Step 1: Add the optional server**

In `scripts/smoke.ts`, extend the header comment's env list and add:

```ts
/**
 * The optional second provider.
 *
 * Present only when NNTP2_HOST is set. Opt-in in the same spirit as
 * NNTP_PROBE_CAP: most runs have one account, and a second one is a real
 * purchase.
 */
function secondServer(): NntpServerOptions | null {
  const host = process.env['NNTP2_HOST'];
  if (host === undefined || host === '') {
    return null;
  }

  const security = process.env['NNTP2_SECURITY'] ?? 'implicit';
  if (security !== 'implicit' && security !== 'starttls' && security !== 'none') {
    throw new Error(`NNTP2_SECURITY must be implicit, starttls or none; got ${security}`);
  }

  return {
    name: host,
    endpoint: { host, port: Number(required('NNTP2_PORT')), security },
    credentials: { user: fromEnv('NNTP2_USER'), pass: fromEnv('NNTP2_PASS') },
    connections: Number(process.env['NNTP2_CONNECTIONS'] ?? '4'),
  };
}
```

Add `NNTP2_USER` and `NNTP2_PASS` to the `SECRETS` array near line 47 so `scrub()` covers them — without this a second provider's password could reach the report.

- [ ] **Step 2: Add the check**

After the connection-cap block:

```ts
const second = secondServer();
if (second !== null) {
  say('\n-- second provider --');
  const multi = new NntpMultiPool({
    servers: [
      {
        name: endpoint().host,
        endpoint: endpoint(),
        credentials: { user: fromEnv('NNTP_USER'), pass: fromEnv('NNTP_PASS') },
        connections: connectionCount(),
      },
      second,
    ],
  });
  try {
    await check('an article the primary lost is fetched from the second', () =>
      fillsTheGap(nzb, multi),
    );
  } finally {
    multi.destroy();
  }
}
```

and the check itself, beside `capacity`:

```ts
/**
 * Fetch the article the primary no longer has.
 *
 * The Linux Journal post's .nfo returned 430 from Newshosting on every run
 * since 2026-08-08, so it is a real expired article rather than a simulated
 * one. If the second provider does not have it either, that is a finding about
 * retention, not a failure of this code -- so the check reports what each
 * server said rather than asserting success.
 */
async function fillsTheGap(
  document: ReturnType<typeof parseNzb>,
  multi: NntpMultiPool,
): Promise<string> {
  const missing = document.files.find((file) => file.subjectHints.name?.endsWith('.nfo') === true);
  if (missing === undefined) {
    return 'no .nfo in this NZB; nothing known to be missing';
  }

  const id = missing.segments[0]?.messageId;
  if (id === undefined) {
    throw new Error('the .nfo lists no segments');
  }

  const report = await multi.statAll(id);
  const summary = report.map((entry) => `${entry.server}=${entry.status}`).join(' ');

  if (!report.some((entry) => entry.status === 'present')) {
    return `${summary}; gone from both, so no gap to fill`;
  }

  const response = await multi.body(id);
  return `${summary}; served ${String(response.body.byteLength)} B by ${response.server ?? 'unknown'}`;
}
```

- [ ] **Step 2 note:** `endpoint()` is called twice above for readability; hoist it to a local if `npm run check` flags the repetition.

- [ ] **Step 3: Verify it type-checks and lints**

Run: `npm run check`
Expected: PASS. `scripts/**/*.ts` is inside `tsconfig.test.json`, so a mistake here is caught.

- [ ] **Step 4: Ask Chad to run it live**

`op run` needs his approval and the credentials are only in `smoke.env`:

```
op run --env-file=../../smoke.env -- node scripts/smoke.ts ../../Linux.Journal.TruePDF-August.2017.nzb
```

Expected: a `-- second provider --` section reporting each server's status for the `.nfo`, and — if the second provider retained it — the byte count and which server served it. That is the first live proof the feature does what it exists for.

- [ ] **Step 5: Stage and ask**

```bash
git add scripts/smoke.ts
# "Add an optional second provider to the smoke test"
```

---

## Mutation testing

After Task 9, before Task 10, run these against `npx vitest run packages/nntp packages/nzb`. Every one should turn the suite red; a survivor means the test that should catch it is missing or too weak. This has found a real gap in roughly a third of the increments in this repo.

| Mutation                                                       | Should be caught by                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Delete the `requireSpillover && !entry.spillover` skip         | "does not spill onto a server that has not opted in"                   |
| Change `#run`'s loop to `Promise.race` over all candidates     | "never contacts the backup when the primary has the article"           |
| Ignore `options.exclude`                                       | "skips a server named in exclude"                                      |
| Reset `consecutiveFailures` in the catch instead of on success | "marks a server down only after three consecutive connection failures" |
| Return `NntpUnavailableError` for the unanimous-430 case       | "throws a 430 when every server said 430"                              |
| Treat a primary auth failure as mark-down                      | "treats an auth failure on the primary as fatal"                       |
| Drop the `tried.includes(server)` guard in `fetchArticle`      | "does not loop when a source ignores exclude"                          |
| Retry on `YencDecodeError` as well as `YencChecksumError`      | "does not retry a malformed article, which is malformed everywhere"    |

## Done when

- `npm run check` passes with roughly 550 tests.
- Every mutation above is caught.
- The smoke test's `-- second provider --` section has been run live once.
- `packages/nzb-cli` is untouched. Its multi-server configuration is a separate spec.
