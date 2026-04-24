-- Swap user_status enum: replace 'away' with 'busy' (Chatwoot parity).
-- Any rows previously storing 'away' are migrated to 'busy'.

ALTER TABLE "public"."account_users" ALTER COLUMN "availability" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."users" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "public"."account_users"
  ALTER COLUMN "availability" SET DATA TYPE text
  USING (CASE WHEN "availability"::text = 'away' THEN 'busy' ELSE "availability"::text END);--> statement-breakpoint
ALTER TABLE "public"."users"
  ALTER COLUMN "status" SET DATA TYPE text
  USING (CASE WHEN "status"::text = 'away' THEN 'busy' ELSE "status"::text END);--> statement-breakpoint

DROP TYPE "public"."user_status";--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('online', 'busy', 'offline');--> statement-breakpoint

ALTER TABLE "public"."account_users"
  ALTER COLUMN "availability" SET DATA TYPE "public"."user_status"
  USING "availability"::"public"."user_status";--> statement-breakpoint
ALTER TABLE "public"."users"
  ALTER COLUMN "status" SET DATA TYPE "public"."user_status"
  USING "status"::"public"."user_status";--> statement-breakpoint

ALTER TABLE "public"."account_users" ALTER COLUMN "availability" SET DEFAULT 'offline'::"public"."user_status";--> statement-breakpoint
ALTER TABLE "public"."users" ALTER COLUMN "status" SET DEFAULT 'offline'::"public"."user_status";
