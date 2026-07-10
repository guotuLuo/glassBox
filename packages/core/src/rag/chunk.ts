/**
 * 分块:定长滑窗 + 重叠。诚实局限:按字符切,不做语义边界识别;
 * 中文按字数、英文按字符,重叠保证跨块句子不丢上下文。真实产品可换递归分块。
 */
export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 320;
  const overlap = opts.overlap ?? 48;
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    // 尽量在段落/句子边界切,避免切碎句子
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const boundary = Math.max(
        slice.lastIndexOf("\n"),
        slice.lastIndexOf("。"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("!"),
        slice.lastIndexOf("?"),
      );
      if (boundary > maxChars * 0.5) end = start + boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks;
}
