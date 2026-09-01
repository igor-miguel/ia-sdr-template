import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Carrega a pasta `conhecimento/` — os arquivos .txt que o time edita.
//
// Você não deve precisar mexer neste arquivo. Ele só lê a pasta, interpreta o
// cabeçalho de cada arquivo e devolve os blocos prontos.
//
// A SEPARAÇÃO ENTRE AS DUAS PASTAS É O PONTO MAIS IMPORTANTE DAQUI:
//
//   conhecimento/empresa/     FATOS  → vão pro RAG (busca) e pro prompt
//   conhecimento/atendimento/ COMPORTAMENTO → SÓ pro prompt, nunca pro RAG
//
// Isso não é organização, é correção. No sistema original os dois estavam
// misturados e a busca degradava: numa pergunta como "vocês aceitam meu plano
// odontológico?" o RAG devolvia "Público-alvo" e "Serviços oferecidos" em vez do
// bloco sobre convênio — os textos de comportamento competiam por similaridade
// com o conteúdo factual e ganhavam. Separar resolveu.
//
// Regra prática: se o texto RESPONDE UMA PERGUNTA DE CLIENTE, é empresa/.
// Se ele diz à IA COMO SE COMPORTAR, é atendimento/.

export interface KnowledgeChunk {
  title: string;
  content: string;
  /**
   * Como o CLIENTE pergunta isso, na língua dele — não na sua.
   *
   * É o campo que faz o RAG acertar. Entra só no texto embarcado na busca; o
   * `content` devolvido à IA continua limpo.
   *
   * Medido no sistema original: "vocês aceitam meu plano odontológico?" não
   * encontrava o bloco que dizia "não trabalhamos com convênio" — as palavras
   * eram outras. Com as perguntas equivalentes, passou a acertar em 1º lugar.
   */
  perguntas?: string[];
}

/** Texto embarcado no pgvector: título + perguntas equivalentes + conteúdo. */
export function textoParaEmbedding(c: KnowledgeChunk): string {
  const perguntas = c.perguntas?.length ? `\nPerguntas equivalentes: ${c.perguntas.join(" ")}` : "";
  return `${c.title}${perguntas}\n${c.content}`;
}

/**
 * Acha a pasta `conhecimento/` subindo a partir deste arquivo.
 *
 * Subir em vez de usar caminho fixo faz o mesmo código funcionar rodando de
 * `src/` (npm run dev) e de `dist/` (produção), que ficam em profundidades
 * diferentes.
 */
function acharPastaConhecimento(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const tentativa = join(dir, "conhecimento");
    if (existsSync(tentativa)) return tentativa;
    const pai = resolve(dir, "..");
    if (pai === dir) break;
    dir = pai;
  }
  throw new Error(
    "Pasta `conhecimento/` não encontrada. Ela fica na raiz do projeto, ao lado do package.json.",
  );
}

/**
 * Formato do arquivo — texto puro, sem dependência de YAML:
 *
 *   titulo: Convênio e plano de saúde
 *   perguntas:
 *     - Vocês aceitam meu plano?
 *     - Atendem por convênio?
 *
 *   O texto da resposta vem depois da linha em branco.
 *
 * O cabeçalho vai do topo até a primeira linha em branco. Cercas `---` em volta
 * dele são aceitas, mas não exigidas: quem preenche não deveria precisar
 * decorar pontuação pra escrever uma informação da empresa.
 */
function interpretar(arquivo: string, bruto: string): KnowledgeChunk {
  const texto = bruto.replace(/^﻿/, "").trim();

  const comCercas = texto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const semCercas = texto.match(/^([\s\S]*?)\r?\n[ \t]*\r?\n([\s\S]*)$/);
  const m = comCercas ?? semCercas;
  if (!m) {
    throw new Error(
      `${arquivo}: formato inválido. Esperado \`titulo:\` no topo, uma linha em branco, ` +
        `e o texto da resposta embaixo. Veja conhecimento/LEIA-ME.txt.`,
    );
  }

  const [, cabecalho, corpo] = m;
  let titulo = "";
  const perguntas: string[] = [];
  let dentroDePerguntas = false;

  for (const linha of cabecalho.split(/\r?\n/)) {
    const item = linha.match(/^\s*-\s+(.*)$/);
    if (dentroDePerguntas && item) {
      perguntas.push(desaspar(item[1]));
      continue;
    }
    dentroDePerguntas = false;

    const campo = linha.match(/^([A-Za-zç]+)\s*:\s*(.*)$/);
    if (!campo) continue;
    const [, chave, valor] = campo;
    if (chave === "titulo") titulo = desaspar(valor);
    else if (chave === "perguntas") {
      dentroDePerguntas = true;
      if (valor.trim()) perguntas.push(desaspar(valor));
    }
  }

  if (!titulo) throw new Error(`${arquivo}: falta a linha \`titulo:\` no topo. Veja conhecimento/LEIA-ME.txt.`);

  const content = corpo.trim();
  if (!content) throw new Error(`${arquivo}: o arquivo tem cabeçalho mas nenhum texto embaixo.`);

  return { title: titulo, content, perguntas: perguntas.length ? perguntas : undefined };
}

const desaspar = (s: string) => s.trim().replace(/^["'](.*)["']$/, "$1");

function carregarPasta(nome: string): KnowledgeChunk[] {
  const dir = join(acharPastaConhecimento(), nome);
  if (!existsSync(dir)) {
    throw new Error(`Pasta \`conhecimento/${nome}/\` não existe.`);
  }

  // Ordem alfabética — por isso os arquivos são numerados (01-, 02-...).
  // A ordem só afeta como o bloco aparece no prompt; a busca não depende dela.
  const arquivos = readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f) && !f.startsWith("_"))
    .sort();

  if (arquivos.length === 0) {
    throw new Error(`Pasta \`conhecimento/${nome}/\` está vazia — a IA ficaria sem informação.`);
  }

  return arquivos.map((f) => interpretar(`conhecimento/${nome}/${f}`, readFileSync(join(dir, f), "utf8")));
}

/**
 * FATOS. Vão pro RAG (`npm run ingest`) e servem de fallback no prompt.
 *
 * Rode `npm run ingest` toda vez que mexer nestes arquivos — senão a busca
 * continua respondendo com a versão antiga.
 */
export const BASE_CONHECIMENTO: KnowledgeChunk[] = carregarPasta("empresa");

/**
 * COMPORTAMENTO. Fica FIXO no prompt, sempre presente.
 *
 * Nunca vai pro RAG de propósito: regra de conduta não pode depender de ser
 * sorteada por similaridade. Se a IA só se comportasse bem quando a busca
 * trouxesse o texto certo, ela se comportaria mal de forma aleatória.
 */
export const DIRETRIZES: KnowledgeChunk[] = carregarPasta("atendimento");
