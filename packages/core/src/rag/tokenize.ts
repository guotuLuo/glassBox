/**
 * 分词(总纲 §6:诚实处理 CJK 局限)。
 * PostgreSQL 内置 FTS 不切中文;这里在应用层做:
 *  - CJK:字符 bigram(相邻两字),中文 IR 的经典特征,无需词典;
 *  - ASCII:小写单词。
 * 同一套 token 既喂 FTS(bigram_doc 串)又喂本地嵌入,两路检索基底一致。
 */

const CJK = /[一-鿿぀-ヿ가-힯]/;

/** 抽 token 多重集:CJK 相邻双字 + ASCII 单词(含数字) */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();
  // ASCII 词(字母/数字连续段)
  for (const m of normalized.matchAll(/[a-z0-9_]+/g)) {
    tokens.push(m[0]);
  }
  // CJK bigram:在连续 CJK 段内取相邻双字
  let run = "";
  const flush = () => {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
    run = "";
  };
  for (const ch of text) {
    if (CJK.test(ch)) run += ch;
    else if (run) flush();
  }
  if (run) flush();
  return tokens;
}

/** FTS 检索串:token 以空格拼接,交给 to_tsvector('simple', ...) */
export function bigramDoc(text: string): string {
  return tokenize(text).join(" ");
}

/** to_tsquery('simple', ...) 的 OR 查询串(召回优先);token 去重、转义 */
export function bigramQuery(text: string): string {
  const uniq = [...new Set(tokenize(text))].filter((t) => t.length > 0);
  return uniq.map((t) => t.replace(/[^a-z0-9_一-鿿぀-ヿ가-힯]/g, "")).join(" | ");
}
