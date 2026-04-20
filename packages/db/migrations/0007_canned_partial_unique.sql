-- Original composite unique treats NULLs as distinct (Postgres default), so
-- two global canned with the same shortcut both pass. Replace with partial
-- unique indexes per visibility, which match the semantic intent.

ALTER TABLE "canned_responses" DROP CONSTRAINT IF EXISTS "canned_shortcut_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "canned_shortcut_global_unique"
  ON "canned_responses" ("shortcut")
  WHERE "visibility" = 'global';
--> statement-breakpoint
CREATE UNIQUE INDEX "canned_shortcut_personal_unique"
  ON "canned_responses" ("owner_id", "shortcut")
  WHERE "visibility" = 'personal';
--> statement-breakpoint
CREATE UNIQUE INDEX "canned_shortcut_inbox_unique"
  ON "canned_responses" ("inbox_id", "shortcut")
  WHERE "visibility" = 'inbox';
