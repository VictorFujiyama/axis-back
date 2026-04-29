CREATE TABLE "module_catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category" text,
	"price" numeric(10, 2) DEFAULT '0' NOT NULL,
	"description" text,
	"image_url" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "module_catalog_products" ADD CONSTRAINT "module_catalog_products_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_catalog_products_account_id_idx" ON "module_catalog_products" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "module_catalog_products_name_idx" ON "module_catalog_products" USING btree ("name");