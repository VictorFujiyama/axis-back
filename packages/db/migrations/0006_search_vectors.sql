-- Full-text search vectors (Postgres built-in) for P4.
-- Portuguese unaccent + stemming. `unaccent` extension available by default on supabase/pg.
-- Using 'simple' config avoids requiring the 'portuguese' dictionary everywhere;
-- future upgrade: CREATE TEXT SEARCH CONFIGURATION for PT-BR with unaccent.

-- Messages: index content.
ALTER TABLE "messages"
  ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("content", ''))
  ) STORED;
--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING GIN ("search_vector");
--> statement-breakpoint

-- Contacts: name + email + phone, with weights (name gets highest).
ALTER TABLE "contacts"
  ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("name", '')), 'A')
    || setweight(to_tsvector('simple', coalesce("email", '')), 'B')
    || setweight(to_tsvector('simple', coalesce("phone", '')), 'C')
  ) STORED;
--> statement-breakpoint
CREATE INDEX "contacts_search_idx" ON "contacts" USING GIN ("search_vector");
--> statement-breakpoint

-- Conversations themselves have no free-text body — they're searched via their
-- messages (messages_search_idx) and their contacts (contacts_search_idx).
-- Keeping this note so future devs don't re-add an unused vector.
