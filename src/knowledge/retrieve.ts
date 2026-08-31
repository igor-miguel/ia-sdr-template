import { supabase } from "../db/supabase.js";
import { embed } from "./embeddings.js";
import { BASE_COMPLETA } from "../agent/systemPrompt.js";

export interface RetrievedChunk {
  title: string;
  content: string;
  similarity: number;
}

/**
 * Piso de similaridade pra um chunk ser considerado resposta.
 *
 * Calibrado em 2026-08-17 contra 19 perguntas reais de paciente: os acertos
 * legítimos ficaram entre 0.394 ("quanto custa uma lente de porcelana?") e 0.684
 * ("a primeira consulta é paga?"), enquanto pergunta claramente fora do escopo
 * ficou em 0.286.
 *
 * Escolhido conservador de propósito. Um falso positivo custa pouco — entra um
 * chunk irrelevante no contexto e o system prompt segura a resposta. Um falso
 * negativo custa caro — o agente responde sobre convênio ou preço sem a
 * informação certa. Na dúvida, deixa passar.
 */
export const SIMILARITY_THRESHOLD = 0.35;

/**
 * Monta o bloco de informações da clínica que vai no contexto do agente, a cada
 * mensagem do paciente.
 *
 * Estratégia deliberadamente conservadora, porque o custo dos dois erros é
 * assimétrico: recuperar um chunk a mais só ocupa contexto, enquanto deixar de
 * recuperar o certo faz a IA responder errado sobre convênio ou preço.
 *
 * Por isso: busca com folga (5 resultados), e **qualquer falha cai para a base
 * completa** — que hoje tem ~2,5 mil caracteres e cabe tranquilamente. O RAG
 * aqui serve para a base poder crescer sem estourar o prompt, não para economizar
 * tokens agora.
 */
export async function montarContextoDaBase(pergunta: string): Promise<string> {
  const cabecalho = "INFORMAÇÕES DA CLÍNICA (responda com base nisto):";
  try {
    const chunks = await retrieveRelevantKnowledge(pergunta, 5);
    if (chunks.length === 0) {
      // Nada passou do corte: pergunta fora do escopo, ou muito vaga ("oi").
      // Mandar a base inteira é melhor do que mandar nada — a IA decide o que usar.
      return `${cabecalho}\n\n${BASE_COMPLETA}`;
    }
    return `${cabecalho}\n\n${chunks.map((c) => `### ${c.title}\n${c.content}`).join("\n\n")}`;
  } catch (err) {
    console.error(`[rag] busca falhou, usando base completa: ${(err as Error).message}`);
    return `${cabecalho}\n\n${BASE_COMPLETA}`;
  }
}

export async function retrieveRelevantKnowledge(
  query: string,
  matchCount = 4,
  threshold = SIMILARITY_THRESHOLD,
): Promise<RetrievedChunk[]> {
  const [queryEmbedding] = await embed([query]);

  const { data, error } = await supabase.rpc("match_clinic_documents", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    match_threshold: threshold,
  });
  if (error) throw error;

  return data as RetrievedChunk[];
}
