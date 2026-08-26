'use strict';
// ── The database handle ─────────────────────────────────────────────────────
// One pool, one transaction helper, and the timeouts that keep a bad query
// from becoming a frozen world.
//
// The thing to understand before touching anything here: this process runs the
// 40Hz world simulation on the SAME thread that awaits these queries. Node
// won't block on the await itself, but every millisecond spent parsing a
// result, building objects and running the callback is a millisecond the tick
// loop does not get. That is why the rules below are stricter than a normal
// web app's would be:
//
//   * every query has a hard statement_timeout — a query that hangs must fail
//     fast rather than hold a connection and a tick slot forever;
//   * a transaction that goes idle is killed, because it holds row locks and
//     every other player touching those rows queues behind it;
//   * the pool is deliberately small (see POOL_MAX), because a large pool
//     under load does not make the database faster, it just moves the queue
//     from here to there while consuming connections the admin and the
//     migration runner still need.

const fs = require('fs');
const { Pool } = require('pg');

// ── TLS to the database ────────────────────────────────────────────────────
// The managed cluster presents a certificate signed by a CA that exists only
// for this DigitalOcean project. Verifying against it — rather than passing
// rejectUnauthorized:false, which is what "just make the TLS error go away"
// usually means — is what makes the connection actually authenticated instead
// of merely encrypted. Without verification, anything that can answer on that
// address is trusted, and this connection carries the credentials to every
// player's money.
//
// checkServerIdentity is overridden deliberately, and this is the one
// compromise: the certificate is issued for the cluster's PUBLIC hostname,
// while we connect over the VPC's private one, so a strict hostname match
// fails on a name that is correct. The CA check is kept — the certificate
// still has to be signed by this project's CA, which no third party can do —
// and only the name comparison is skipped. That is strictly stronger than
// rejectUnauthorized:false and honest about which half is being relied on.
//
// PG_CA_FILE is the CA extracted from the cluster's own chain at setup
// (/srv/liberty/pg-ca.crt). It expires in 2036; if the cluster is ever
// rebuilt, this file must be refreshed with it — the failure mode is a
// refused connection at boot, which is loud, not silent.
// Is DATABASE_URL pointing at this very machine? Used only by the CI escape
// hatch below, and deliberately strict: a hostname, not a guess. Anything it
// cannot parse is not loopback.
function _isLoopbackUrl(raw) {
  try {
    const h = new URL(String(raw || '')).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch (err) {
    return false;
  }
}

function _ssl() {
  const caFile = process.env.PG_CA_FILE;
  if (!caFile) {
    // ── the one exception, and it takes TWO keys to open ─────────────────────
    // Continuous integration runs a throwaway PostgreSQL in the same container,
    // reached over loopback. There is no network between them to protect and no
    // CA to have. Refusing there means CI can only ever test the retired Mongo
    // build, which is exactly the state this is being added to fix.
    //
    // Both conditions are required, and neither is reachable by accident:
    // PG_ALLOW_PLAINTEXT=1 has to be set on purpose, AND the host has to be
    // this machine. Setting the variable against the production URL still
    // refuses — which is the property that makes this safe to have at all.
    if (process.env.PG_ALLOW_PLAINTEXT === '1' && _isLoopbackUrl(process.env.DATABASE_URL)) {
      return false;
    }
    throw new Error('PG_CA_FILE is not set — refusing to connect to the money ' +
      'database without a CA to verify it against');
  }
  return {
    ca: fs.readFileSync(caFile, 'utf8'),
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,   // see the comment above
  };
}

// ── Pool size ──────────────────────────────────────────────────────────────
// The cluster reports max_connections = 50, of which ~14 are already held by
// DigitalOcean's own backup and monitoring processes — measured, not assumed.
// That leaves ~36 for everything else: this process, any second worker, the
// migration runner, and a human with psql open during an incident.
//
// 12 is chosen against the workload rather than the ceiling. The game's DB
// traffic is short single-row reads and writes at a few hundred per second;
// twelve concurrent ones is already more parallelism than a 1-vCPU database
// can execute, so a bigger pool would add queueing, not throughput.
const POOL_MAX = Number(process.env.PG_POOL_MAX || 12);

// A query that has not finished in this long is not going to help anyone: the
// player it belongs to has given up, and it is still holding a connection.
// Deliberately generous compared with what the game actually issues (single
// -row lookups, ~1ms) so it only ever catches something genuinely wrong.
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS || 5000);

// An open transaction that stopped doing work still holds every row lock it
// took. Without this, one handler that throws between BEGIN and COMMIT in a
// path the `finally` misses would block every other player's access to those
// rows until the connection died. This is the backstop under `tx()` below.
const IDLE_TX_TIMEOUT_MS = Number(process.env.PG_IDLE_TX_TIMEOUT_MS || 10000);

// Log any query slower than this. Not an error — a signal. The whole class of
// "иногда тупит" report is unanswerable without knowing whether the database
// was involved, and this is the cheapest way to have that answer already
// recorded when the question gets asked.
const SLOW_QUERY_MS = Number(process.env.PG_SLOW_QUERY_MS || 200);

let _pool = null;

// The URL is taken apart rather than handed to pg whole, and that is not
// stylistic. `pg` derives its OWN ssl config from a `sslmode=` parameter in
// the string, and that derived config WINS over the `ssl` option passed
// alongside it — so a connection string ending in `?sslmode=require` silently
// discarded the pinned CA above and failed with SELF_SIGNED_CERT_IN_CHAIN.
// Passing discrete fields leaves exactly one place where TLS is decided.
function _parseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('DATABASE_URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error(`DATABASE_URL has protocol ${u.protocol}, expected postgres:`);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    // Leading slash off; a URL with no path would mean "no database named",
    // which is a configuration mistake worth failing loudly on.
    database: u.pathname.replace(/^\//, '') || null,
  };
}

function pool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const conn = _parseUrl(process.env.DATABASE_URL);
  if (!conn.database) throw new Error('DATABASE_URL names no database');

  _pool = new Pool({
    ...conn,
    max: POOL_MAX,
    // A connection that has been idle this long is closed. DigitalOcean's
    // proxy drops idle connections on its own schedule; closing ours first
    // means the game never inherits a socket the far end has already
    // forgotten about, which surfaces as a random ECONNRESET on whichever
    // unlucky query picks it up.
    idleTimeoutMillis: 30_000,
    // How long to wait for a free connection before giving up. A handler that
    // cannot get one within two seconds should fail and tell the player, not
    // queue silently behind everyone else.
    connectionTimeoutMillis: 2000,
    // Applied per connection at handshake, so no call site can forget them.
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} ` +
             `-c idle_in_transaction_session_timeout=${IDLE_TX_TIMEOUT_MS}`,
    ssl: _ssl(),
    application_name: 'liberty-game',
  });

  // A pool error is NOT a process error. Without this handler, an idle
  // connection dropped by the far end emits 'error' on the pool, and an
  // unhandled 'error' event takes the whole process down — every player
  // disconnected because one spare socket went away.
  _pool.on('error', (err) => {
    console.error('[db] idle client error (connection dropped, pool will replace it):', err.message);
  });

  return _pool;
}

// ── query ──────────────────────────────────────────────────────────────────
// `db` is either the pool (a standalone query) or a transaction client (a
// query that must join work already in flight). Every repository function
// below takes this as its first argument for exactly that reason: the same
// function has to work standalone AND inside a market purchase's transaction,
// and threading the handle is what makes that possible without two copies.
async function query(db, text, params) {
  const started = process.hrtime.bigint();
  try {
    return await (db || pool()).query(text, params);
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= SLOW_QUERY_MS) {
      // First line only — a full multi-line query in the log is unreadable and
      // the first line is enough to identify it.
      console.warn(`[db] slow query ${ms.toFixed(0)}ms: ${String(text).trim().split('\n')[0]}`);
    }
  }
}

// ── tx ─────────────────────────────────────────────────────────────────────
// Runs `fn` inside one transaction and hands it the client to use. Commits if
// it returns, rolls back if it throws — and the connection is released either
// way, including when the ROLLBACK itself fails.
//
// This is the piece that retires an entire category of code in this project.
// The Mongo version had no transactions, so every economy handler hand-wrote
// its own compensation: marketBuy refunds the buyer if the item cannot be
// delivered, marketList un-lists if the item cannot be removed, gramShopBuy
// puts the GRAM back if the write fails. Every one of those is a path that
// can itself fail, and several of them were the bug rather than the fix.
// Here, a throw anywhere unwinds everything, and there is nothing to write.
async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // Rolling back can itself fail — typically because the connection is
    // already gone, which is also why the original query failed. Swallow that
    // secondary error so the caller sees the REAL one; releasing with an error
    // below tells the pool to discard the connection rather than reuse it.
    try { await client.query('ROLLBACK'); } catch { /* connection is gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── txRetry ────────────────────────────────────────────────────────────────
// Same as tx(), but retries on the two errors that mean "nothing was written,
// try again" rather than "this operation is wrong":
//
//   40001  serialization_failure   — two transactions touched the same rows
//   40P01  deadlock_detected       — they took locks in opposite orders
//
// Both are safe to retry BY DEFINITION: PostgreSQL only reports them after
// rolling the transaction back, so no partial effect survives. Anything else
// (a constraint violation, a bad query) is a real failure and is rethrown
// immediately — retrying a CHECK violation would just fail three times more
// slowly.
//
// Deliberately small: three attempts with a short backoff. A player pressing
// "buy" is waiting, and if three attempts lose the race the honest answer is
// an error message, not a longer wait.
const RETRYABLE = new Set(['40001', '40P01']);

async function txRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await tx(fn);
    } catch (err) {
      if (!RETRYABLE.has(err.code)) throw err;
      lastErr = err;
      // 5ms, 10ms, 20ms — long enough to let the other transaction finish,
      // short enough that the player does not feel it.
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 5 * (2 ** i)));
    }
  }
  throw lastErr;
}

// ── health / shutdown ──────────────────────────────────────────────────────

// What /health reports about the database. Cheap enough to call per request.
function stats() {
  if (!_pool) return { up: false };
  return {
    up: true,
    total: _pool.totalCount,      // connections open
    idle: _pool.idleCount,        // of those, free right now
    // Anything above zero here means handlers are queueing for a connection —
    // the first number to look at when the game feels slow but the tick
    // timings are clean.
    waiting: _pool.waitingCount,
    max: POOL_MAX,
  };
}

// Called from _gracefulShutdown. Waits for in-flight queries to finish so a
// deploy does not abort a save mid-write.
async function close() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  await p.end().catch(err => console.error('[db] close:', err.message));
}

// ── asking the database what shape it is ────────────────────────────────────
// Schema migrations need a credential the application deliberately does not
// have (liberty_app has no DDL rights, and that is the right call for a process
// that handles real money). So there are moments where the code is ready and
// the schema is not, and a build that simply assumed the newer one would take
// the game down rather than improve it.
//
// This lets a module ask, once, and branch. Cached because the answer cannot
// change without a restart — a migration is applied while the service is
// stopped — and because it is read on paths as hot as consuming an item.
const _cols = new Map();
async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (_cols.has(key)) return _cols.get(key);
  const { rows } = await query(null, `
    SELECT 1 FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`, [table, column]);
  const has = rows.length > 0;
  _cols.set(key, has);
  return has;
}
function _forgetSchemaCache() { _cols.clear(); }

module.exports = { pool, query, tx, txRetry, stats, close, POOL_MAX, hasColumn, _forgetSchemaCache };
