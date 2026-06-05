// Unit tests for the Apple-client empty-playlist 404 discriminator
// (live-test finding): Apple returns 404 / code 40403 / "No related resources"
// on the `/tracks` relationship of a ZERO-track playlist instead of an empty
// list. listLibraryPlaylistTracks must absorb ONLY that shape (→ []), and must
// still propagate a genuinely-missing playlist (code 40400) so a typo'd id
// doesn't silently look "empty".

import { HttpError } from "../util/http.js";
import { isEmptyRelationship404 } from "./apple.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${msg}\n`);
}

const EMPTY_BODY = JSON.stringify({
  errors: [
    {
      id: "X",
      title: "No related resources",
      detail: "No related resources found for tracks",
      status: "404",
      code: "40403",
    },
  ],
});
const MISSING_BODY = JSON.stringify({
  errors: [
    {
      id: "Y",
      title: "Resource Not Found",
      detail: "id does not match an existing resource",
      status: "404",
      code: "40400",
    },
  ],
});

// Empty-relationship 404 → absorbed (true).
assert(
  isEmptyRelationship404(
    new HttpError(
      404,
      EMPTY_BODY,
      "https://api.music.apple.com/v1/me/library/playlists/p.X/tracks",
    ),
  ),
  "empty-playlist 404 (code 40403) → true",
);
assert(
  isEmptyRelationship404(
    new HttpError(404, JSON.stringify({ errors: [{ title: "No Related Resources" }] }), "u"),
  ),
  "empty-playlist 404 (title 'No related resources', case-insensitive) → true",
);

// Genuinely-missing playlist 404 → must propagate (false).
assert(
  !isEmptyRelationship404(new HttpError(404, MISSING_BODY, "u")),
  "missing playlist 404 (code 40400) → false (propagates)",
);

// Non-404 errors → false.
assert(
  !isEmptyRelationship404(new HttpError(401, EMPTY_BODY, "u")),
  "401 with 40403-ish body → false (not a 404)",
);
assert(!isEmptyRelationship404(new HttpError(500, "internal", "u")), "500 → false");

// Non-HttpError values → false (no crash).
assert(!isEmptyRelationship404(new Error("boom")), "plain Error → false");
assert(!isEmptyRelationship404(null), "null → false");
assert(!isEmptyRelationship404(undefined), "undefined → false");
