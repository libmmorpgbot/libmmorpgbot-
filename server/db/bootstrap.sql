-- ═══════════════════════════════════════════════════════════════════════════
--  bootstrap — the database and the role the application runs as
-- ═══════════════════════════════════════════════════════════════════════════
-- Run ONCE, as doadmin, against `defaultdb`, BEFORE any migration.
--
-- Why not just use doadmin/defaultdb, which DigitalOcean hands you ready to
-- go: doadmin can create and drop databases, create roles, and read every
-- other database in the cluster. The game server is an internet-facing process
-- holding real money — if it is ever compromised, the difference between
-- "the attacker can read and write game rows" and "the attacker can DROP the
-- database" is the difference between an incident and a company-ending one.
--
-- So the application gets a role that can do exactly what the game does at
-- runtime (SELECT/INSERT/UPDATE/DELETE on the game tables, USAGE on their
-- sequences) and nothing else. Schema changes are applied separately, by
-- doadmin, by a human running the migration script.
--
-- CREATE DATABASE cannot run inside a transaction block, which is why this is
-- its own file rather than the first migration.

-- ── The application role ───────────────────────────────────────────────────
-- Password is substituted by migrate.sh from $APP_DB_PASSWORD so it never
-- lands in a file, in git, or in this repository's history.
CREATE ROLE liberty_app WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

-- ── The database ───────────────────────────────────────────────────────────
-- Owned by doadmin, NOT by liberty_app: an owner can drop its own tables
-- regardless of what GRANTs say, so ownership is the privilege that actually
-- has to be withheld.
CREATE DATABASE liberty OWNER doadmin
  ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;

-- Connect, but nothing else yet. The rest of the grants are applied by
-- migrate.sh AFTER the tables exist (a GRANT names objects, so it cannot
-- precede them), including the DEFAULT PRIVILEGES that cover tables added by
-- later migrations without anyone having to remember to re-grant.
GRANT CONNECT ON DATABASE liberty TO liberty_app;

-- PUBLIC may create objects in the public schema by default in older
-- PostgreSQL and that is a well-known footgun; PostgreSQL 15+ already
-- revokes it, but stating it makes the intent explicit and survives a
-- restore onto an older server.
REVOKE ALL ON DATABASE liberty FROM PUBLIC;
