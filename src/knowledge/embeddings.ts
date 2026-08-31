import OpenAI from "openai";
import { config } from "../config.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

// text-embedding-3-small: 1536 dimensões — precisa bater com o tipo da coluna
// clinic_documents.embedding no Supabase (ver migrations/006_openai_embeddings.sql).
export async function embed(texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}
