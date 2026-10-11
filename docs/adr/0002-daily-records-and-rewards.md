# ADR 0002: Unified daily entries with historical reward snapshots

Status: Accepted  
Date: 2026-10-11

## Context

Ordinary habits and reason-specific journals both repeat by day. A journal must
contain writing before it counts as completed. Users need to browse previous
writings and reflections, undo completions, customize habits/stats, and retain
their history indefinitely without a maximum rank.

## Decision

Model both activities as habits, distinguished by `check` or `journal` kind.
Store a single daily entry per habit and local calendar date. Entries include
completion, prompted content, optional good/bad/improve reflections, and optional
sleep and health observations. Journal completion requires nonblank content.

Store the awarded stat and awarded points on the daily entry at completion.
Compute social-stat totals from completed historical snapshots. A repeated save
must not award again; undo reverses the stored award; recompleting uses the
habit's current reward configuration. Apply database changes transactionally.

Dates are calendar dates, not UTC instants. Historical dates can be edited;
future completion is disallowed. Archiving hides a habit from the current agenda
without destroying records. Provide a versioned JSON backup with validated,
transactional restore rather than trusting imported stat totals.

## Consequences

- Heatmaps and history share the same source of truth as the daily agenda.
- Changing a habit's stat or points never silently rewrites earned history.
- Text can be updated without awarding points a second time.
- Points have no ranks, ceiling, or implied maximum progression. Unlimited rank
  systems can be discussed later without changing the current reward ledger.
- SQLite enforces record uniqueness in addition to request validation.
