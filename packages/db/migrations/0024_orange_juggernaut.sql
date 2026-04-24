ALTER TABLE "conversations" ALTER COLUMN "priority" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "priority" DROP NOT NULL;