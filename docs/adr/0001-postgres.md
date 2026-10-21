# ADR 0001: Move the booking data to PostgreSQL

- **Status:** accepted
- **Date:** 2026-10-21

## Context

The product stores everything in Firestore, behind a FlutterFlow app. Firestore served the first years well: no servers, realtime updates, offline support. But the business now needs:

- **Integrity the app can't guarantee on its own:** no double bookings, no bookings pointing at deleted students, one student per person. Firestore enforces no schema and no relations, so every rule lives in app code, and every old app version still in the stores runs the old rules.
- **Reporting:** lessons per instructor per month, revenue per city, no-show rates. In Firestore that means exporting data or keeping counters by hand.
- **Predictable cost:** Firestore bills per document read. A calendar screen that reads a week of lessons costs reads on every open, and costs grow with usage in ways that are hard to forecast.

## Decision

Move the booking domain to **PostgreSQL 16**, with the rules in the schema:
- foreign keys between cities, pickup points, instructors, students and bookings
- CHECK constraints for statuses, durations, prices, phone (E.164) and tax-code formats
- an **exclusion constraint** that makes overlapping active lessons impossible ([ADR 0002](0002-exclusion-constraint.md))
- money as integer cents, and all timestamps as `timestamptz` in UTC

A Node.js (TypeScript, Fastify) API sits in front of it. Hosting is managed Postgres in an EU region, for example Cloud SQL `europe-west8` (Milan).

## Consequences

- **Bad states become impossible, not just unlikely.** The database refuses them, whatever client or app version sends them.
- **Reporting is plain SQL.**
- **Cost is a fixed instance size,** not a function of how often screens are opened.
- **We now run a database:** backups, upgrades, connection limits. A managed service covers most of it.
- **We lose Firestore's built-in realtime listeners and offline cache** for the screens we move. Screens that truly need realtime keep a listener, or get a websocket later.
- **The move itself must be done carefully:** with the app live, and old app versions still reading Firestore. That is the subject of [the migration strategy](../migration-strategy.md).

## Alternatives considered

- **Stay on Firestore and add rules in Cloud Functions.** Checks in functions can't stop two concurrent writes from both succeeding, and old app versions can bypass them. Integrity stays probabilistic.
- **Another document store.** The same lack of relations and constraints; it doesn't solve the problem.
- **Postgres with an ORM-managed schema.** We want the constraints written in SQL and visible in review, so migrations are plain SQL files and queries use Kysely, a typed query builder.
