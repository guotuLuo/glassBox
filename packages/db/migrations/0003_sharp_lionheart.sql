CREATE TABLE "memories" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "ix_memories_owner" ON "memories" USING btree ("owner_id");--> statement-breakpoint
-- 向量近邻:HNSW + cosine(手工加,drizzle 不生成 pgvector 索引)
CREATE INDEX "ix_memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);