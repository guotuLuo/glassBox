import { type Db, documentChunks, documents } from "@glassbox/db";
import { type ChunkOptions, chunkText } from "./chunk.js";
import type { EmbeddingProvider } from "./embed.js";
import { bigramDoc } from "./tokenize.js";

export interface IngestInput {
  title: string;
  source: string;
  text: string;
  ownerId?: string;
}

export interface IngestResult {
  documentId: string;
  chunks: number;
}

/** 摄取:建文档 → 分块 → 嵌入 → 落库(content + bigram 检索串 + 向量),同事务 */
export async function ingestDocument(
  db: Db,
  embedder: EmbeddingProvider,
  input: IngestInput,
  chunkOpts?: ChunkOptions,
): Promise<IngestResult> {
  const pieces = chunkText(input.text, chunkOpts);
  if (pieces.length === 0) throw new Error("document has no content to ingest");
  const vectors = await embedder.embed(pieces);

  return db.transaction(async (tx) => {
    const docRows = await tx
      .insert(documents)
      .values({
        title: input.title,
        source: input.source,
        ownerId: input.ownerId ?? null,
      })
      .returning({ id: documents.id });
    const documentId = docRows[0]?.id;
    if (!documentId) throw new Error("document insert returned no row");

    await tx.insert(documentChunks).values(
      pieces.map((content, i) => ({
        documentId,
        chunkIndex: i,
        content,
        bigramDoc: bigramDoc(content),
        embedding: vectors[i] ?? [],
      })),
    );
    return { documentId, chunks: pieces.length };
  });
}
