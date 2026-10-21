# Data-quality decisions

Every way the source data can be wrong, the rule we apply, and what happens to the record:
- **Fix:** the record imports, corrected silently.
- **Warn:** it imports, and the run records a warning.
- **Reject:** it doesn't import; it goes to `migration_rejects` with one reason code.

The codes live in [`src/normalize/result.ts`](../src/normalize/result.ts), and tests assert on them. Fixture ids refer to MASTER_PLAN §3.2.

**Owners:**
- **Eng:** the migration team; the rule is in code and tested.
- **Ops:** support resolves the individual records from the rejects report.
- **Product:** a business decision is still needed.

## Identity and references

| Issue | Example | Rule | Outcome | Code | Owner | Status |
|---|---|---|---|---|---|---|
| Same person signed up twice | `st_dup_rossi_a` / `_b` | Match on trimmed, lower-cased email. The oldest sign-up survives (ties: doc id); empty fields are filled from the newer doc; both ids go in `legacy_id_map` | Warn | `DUPLICATE_MERGED` | Eng | Done |
| Booking points at a merged duplicate | `bk_dup_student_ref` | Resolve through `legacy_id_map` to the surviving student | Fix | – | Eng | Done |
| Booking's student doesn't exist | `bk_orphan_student` | Can't guess the student | Reject | `ORPHAN_STUDENT` | Ops | Done |
| Booking's instructor doesn't exist | `bk_orphan_instructor` | Can't guess the instructor | Reject | `ORPHAN_INSTRUCTOR` | Ops | Done |
| Booking's pickup point doesn't exist | (no fixture) | Keep the lesson without a pickup point | Warn | `ORPHAN_PICKUP_POINT` | Ops | Done |
| Pickup point's or instructor's city doesn't exist | (no fixture) | `city_id` is required. Rejecting an instructor also rejects their bookings as `ORPHAN_INSTRUCTOR` | Reject | `ORPHAN_CITY` | Ops | Done |
| Student's city doesn't exist | (no fixture) | `city_id` is optional for students | Warn | `CITY_UNKNOWN` | Ops | Done |

## Double bookings

| Issue | Example | Rule | Outcome | Code | Owner | Status |
|---|---|---|---|---|---|---|
| Same instructor, overlapping active lessons | `bk_overlap_a` + `bk_overlap_b` | First stored wins (document-id order). The other is rejected, naming the holder. No automatic winner beyond that | `a` imports; `b` rejected | `OVERLAP_INSTRUCTOR` | Ops | Done; ops resolves `b` |
| Same student, two lessons at once | `bk_student_base` + `bk_student_overlap` | Same rule, on the student | `base` imports; `overlap` rejected | `OVERLAP_STUDENT` | Ops | Done; ops resolves |
| Overlap with a cancelled lesson | `bk_overlap_cancelled` | Only `booked` and `confirmed` lessons block | Import | – | Eng | Done |
| Lessons back to back | `bk_adjacent_1` / `_2` | Time ranges are half-open `[start, end)`, so 11:00 can follow a lesson ending at 11:00 | Import both | – | Eng | Done |
| Overlap with a deleted lesson | `bk_deleted` overlaps `bk_price_string` | Deleted lessons never block | Import both | – | Eng | Done |

## Dates and times

| Issue | Example | Rule | Outcome | Code | Owner | Status |
|---|---|---|---|---|---|---|
| Firestore Timestamp | `bk_date_timestamp` | The normal case | Import | – | Eng | Done |
| ISO string with an offset | `bk_date_iso` | Unambiguous | Import | – | Eng | Done |
| Italian local time as text | `bk_date_it_string` `"21/10/2026 14:30"` | Read as Europe/Rome wall-clock time | Warn | `DATE_PARSED_FROM_STRING` | Eng | Done |
| Epoch milliseconds | `bk_date_epoch` | Milliseconds since 1970, sanity-checked (years 2000–2099) | Warn | `DATE_PARSED_FROM_NUMBER` | Eng | Done |
| Words instead of a date | `bk_date_garbage` `"domani pomeriggio"` | No guessing | Reject | `INVALID_DATE` | Ops | Done |
| A time that doesn't exist (spring clock change) | `bk_dst_gap` `"29/03/2026 02:30"` | Luxon would quietly move it to 03:30; we check and refuse | Reject | `DST_GAP` | Ops | Done |
| A time that happens twice (autumn clock change) | `bk_dst_ambiguous` `"25/10/2026 02:30"` | Take the first occurrence (summer time, 00:30Z) | Warn | `DATE_AMBIGUOUS` | Eng | Done |

The four "same instant" fixtures (Timestamp, ISO, Italian and epoch) all resolve to 2026-10-21 12:30Z, and a test checks it.

## Status, duration, price

| Issue | Example | Rule | Outcome | Code | Owner | Status |
|---|---|---|---|---|---|---|
| Status spelled differently | `"Cancelled"`, `"canceled"`, `" CONFIRMED "`, `"noshow"` | Trim and lower-case, then map: `canceled`→`cancelled`, `noshow`/`no-show`/`no show`→`no_show` | Warn | `STATUS_NORMALIZED` | Eng | Done |
| **`"rescheduled"`** | `bk_status_unknown` | No target status exists. Is it a cancel plus a new booking, or a moved booking? | Reject | `INVALID_STATUS` | **Product** | **Needs product decision** |
| Other unknown status | (no fixture) | No guessing | Reject | `INVALID_STATUS` | Ops | Done |
| Duration missing | `bk_no_duration` | Default 60 minutes | Warn | `DURATION_DEFAULTED` | Eng | Done |
| Duration outside 15–240 minutes, or not a whole number | `bk_bad_duration` (600) | Matches the schema's CHECK | Reject | `INVALID_DURATION` | Ops | Done |
| Price as text with a comma | `bk_price_string` `"45,50"` | Read digit by digit into cents (4550), never through floating point | Warn | `PRICE_PARSED_FROM_STRING` | Eng | Done |
| Price missing | (no fixture) | Import with no price | Warn | `PRICE_MISSING` | Ops | Done |
| Price negative or unreadable | (no fixture) | No guessing | Reject | `INVALID_PRICE` | Ops | Done |

## Contact and identity fields

| Issue | Example | Rule | Outcome | Code | Owner | Status |
|---|---|---|---|---|---|---|
| Phone is a note, not a number | `st_bad_phone` `"chiamami dopo le 18"` | Keep the student; leave the phone empty | Warn | `PHONE_UNPARSEABLE` | Ops | Done |
| Phone in another format | `st_phone_formats_1/2/3` | Read as Italian, store as E.164 `+393331234567`. Warn only when it changed | Fix / Warn | `PHONE_NORMALIZED` | Eng | Done |
| Tax code malformed | (no fixture) | Trim, remove spaces, upper-case; otherwise leave it empty | Warn | `TAX_CODE_INVALID` | Ops | Done |
| Licence category unknown | (no fixture) | Upper-case (`"b"` → `"B"`); otherwise empty. For instructors, only the unknown entry is dropped | Warn | `LICENSE_CATEGORY_INVALID` | Ops | Done |
| Email with spaces or capitals | `" Mario.Rossi@Example.com"` | Store it trimmed with its casing; match and index on lower case | Fix | – | Eng | Done |

## Structure

| Issue | Example | Rule | Outcome | Code | Owner | Status |
|---|---|---|---|---|---|---|
| Copied names drifted from the source | `bk_denorm_drift` `"Mario R."` | Compare ignoring spacing and case. Postgres keeps only the foreign keys, never the copied names | Warn | `DENORM_DRIFT` | Eng | Done |
| Extra fields nobody knows | `bk_unknown_fields` (`legacyFlag`, `tmp2`) | Import; list the field names so nothing disappears unnoticed | Warn | `UNKNOWN_FIELDS` | Eng | Done |
| Nested status history | `bk_history_nested` | Each entry becomes a `booking_events` row; a re-run adds none | Import | – | Eng | Done |
| A history entry without a readable status or time | (no fixture) | Drop that entry only | Warn | `HISTORY_ENTRY_DROPPED` | Eng | Done |
| Soft-deleted doc | `bk_deleted` | `deleted: true` → `deleted_at` = the doc's last update time | Import | – | Eng | Done |
| Pickup-point coordinates half missing or out of range | (no fixture) | Both or neither: set both to null | Warn | `COORDINATES_INVALID` | Ops | Done |
| A required field missing | (no fixture) | The detail names the field | Reject | `MISSING_REQUIRED_FIELD` | Ops | Done |
| Anything no rule above covers (e.g. `paid: "yes"`) | (no fixture) | The strict output schema is the safety net; the detail names the field paths | Reject | `INVALID_RECORD` | Eng | Done |

## Known limits

- **Merged students aren't split again.** If an email later changes so that two merged sign-ups no longer match, sync creates the second as its own student, but the survivor keeps any fields it had filled from it.
- **Removing a duplicate's doc** leaves the merged student unchanged. Removing the survivor's doc soft-deletes the merged student.
- **Ambiguous autumn times take the first occurrence.** A lesson at 02:30 on the night the clocks go back is rare; if a real one turns up, ops checks it with the student.
- **Cities, pickup points and instructors have no soft delete.** When one is removed from Firestore, it stays in Postgres, and reconciliation reports it as `extra_in_pg` for a person to decide.
- **A normaliser fix needs `--force` to apply to rows already imported.** The newer-wins rule leaves a doc alone unless its `updateTime` moves. The `--force` flag isn't built yet.
