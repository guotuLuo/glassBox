import {
  type EmbeddingProvider,
  embeddingFromEnv,
  hybridSearch,
  ingestDocument,
} from "@glassbox/core";
import { type DbHandle, documentChunks, documents } from "@glassbox/db";
import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "./db.provider.js";
import { ZodValidationPipe } from "./zod.pipe.js";

const ingestSchema = z.object({
  title: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  text: z.string().min(1).max(50_000),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  k: z.coerce.number().int().min(1).max(20).default(8),
});

/** M3 召回 playground 的后端:摄取 + 混合检索(带分路诊断) */
@Controller("api/rag")
export class RagController {
  private readonly embedder: EmbeddingProvider = embeddingFromEnv();

  constructor(@Inject(DB) private readonly dbh: DbHandle) {}

  @Post("ingest")
  async ingest(@Body(new ZodValidationPipe(ingestSchema)) body: z.infer<typeof ingestSchema>) {
    const result = await ingestDocument(this.dbh.db, this.embedder, body);
    return { ...result, embedder: this.embedder.name };
  }

  @Get("search")
  async search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
  ) {
    const candidates = await hybridSearch(this.dbh.db, this.embedder, query.q, {
      topK: query.k,
      perChannel: 20,
    });
    return { query: query.q, embedder: this.embedder.name, candidates };
  }

  @Get("stats")
  async stats() {
    const [docs] = await this.dbh.db.select({ n: sql<number>`count(*)::int` }).from(documents);
    const [chunks] = await this.dbh.db
      .select({ n: sql<number>`count(*)::int` })
      .from(documentChunks);
    return { documents: docs?.n ?? 0, chunks: chunks?.n ?? 0 };
  }
}
