import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Lê o arquivo BASE-DE-CONHECIMENTO.txt, na raiz do projeto.
//
// Você não deve precisar mexer aqui. Este módulo só interpreta o arquivo e
// devolve os blocos prontos. As instruções de preenchimento estão no topo do
// próprio .txt, pra quem edita não precisar abrir código nenhum.
//
// A SEPARAÇÃO ENTRE AS DUAS SEÇÕES É O PONTO MAIS IMPORTANTE DAQUI:
//
//   [EMPRESA]      FATOS  → vão pro RAG (busca) e pro prompt
//   [ATENDIMENTO]  COMPORTAMENTO → SÓ pro prompt, nunca pro RAG
//
// Isso não é organização, é correção. No sistema original os dois estavam
// misturados e a busca degradava: numa pergunta como "vocês aceitam meu plano
// odontológico?" o RAG devolvia "Público-alvo" e "Serviços oferecidos" em vez
// do bloco sobre convênio — os textos de comportamento competiam por
// similaridade com o conteúdo factual e ganhavam. Separar resolveu.

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

export const NOME_DO_ARQUIVO = "BASE-DE-CONHECIMENTO.txt";

/**
 * Acha o arquivo subindo a partir deste módulo.
 *
 * Subir em vez de usar caminho fixo faz o mesmo código funcionar rodando de
 * `src/` (npm run dev) e de `dist/` (produção), que ficam em profundidades
 * diferentes.
 */
function acharArquivo(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const tentativa = join(dir, NOME_DO_ARQUIVO);
    if (existsSync(tentativa)) return tentativa;
    const pai = resolve(dir, "..");
    if (pai === dir) break;
    dir = pai;
  }
  throw new Error(
    `${NOME_DO_ARQUIVO} não encontrado. Ele fica na raiz do projeto, ao lado do package.json.`,
  );
}

const SEPARADOR = /^\s*={3,}\s*$/;
const SECAO = /^\s*\[\s*(EMPRESA|ATENDIMENTO)\s*\]\s*$/i;
const COMENTARIO = /^\s*#/;

/**
 * Interpreta um bloco:
 *
 *   titulo: Convênio e plano de saúde
 *   perguntas:
 *   - Vocês aceitam meu plano?
 *   resposta:
 *   Não trabalhamos com convênio...
 *
 * As mensagens de erro citam o título do bloco (ou o número dele, quando é o
 * título que falta) porque quem edita não tem número de linha à mão: ele está
 * olhando um .txt, não um editor de código.
 */
function interpretarBloco(bruto: string, secao: string, indice: number): KnowledgeChunk | null {
  const linhas = bruto.split(/\r?\n/).filter((l) => !COMENTARIO.test(l));
  if (linhas.every((l) => !l.trim())) return null; // bloco vazio: separador sobrando

  let titulo = "";
  const perguntas: string[] = [];
  const resposta: string[] = [];
  let campo: "perguntas" | "resposta" | null = null;

  for (const linha of linhas) {
    const cabecalho = linha.match(/^\s*(titulo|título|perguntas|resposta)\s*:\s*(.*)$/i);
    if (cabecalho) {
      const chave = cabecalho[1].toLowerCase().replace("título", "titulo");
      const valor = cabecalho[2].trim();
      if (chave === "titulo") {
        titulo = valor;
        campo = null;
      } else if (chave === "perguntas") {
        campo = "perguntas";
        if (valor) perguntas.push(valor);
      } else {
        campo = "resposta";
        if (valor) resposta.push(valor);
      }
      continue;
    }

    if (campo === "perguntas") {
      const item = linha.match(/^\s*[-*•]\s*(.+)$/);
      if (item) {
        perguntas.push(item[1].trim());
        continue;
      }
      if (!linha.trim()) continue;
      // Linha solta depois de `perguntas:` sem hífen — trata como pergunta,
      // em vez de descartar em silêncio.
      perguntas.push(linha.trim());
      continue;
    }

    if (campo === "resposta") resposta.push(linha);
  }

  const onde = titulo ? `no bloco "${titulo}"` : `no bloco nº ${indice + 1} da seção [${secao}]`;

  if (!titulo) {
    throw new Error(
      `${NOME_DO_ARQUIVO}: falta a linha "titulo:" ${onde}. ` +
        `Todo bloco precisa de um título.`,
    );
  }

  const content = resposta.join("\n").trim();
  if (!content) {
    throw new Error(
      `${NOME_DO_ARQUIVO}: falta a linha "resposta:" (ou ela está vazia) ${onde}. ` +
        `Sem resposta a IA não tem o que dizer sobre esse assunto.`,
    );
  }

  return { title: titulo, content, perguntas: perguntas.length ? perguntas : undefined };
}

function carregar(): { empresa: KnowledgeChunk[]; atendimento: KnowledgeChunk[] } {
  const texto = readFileSync(acharArquivo(), "utf8").replace(/^﻿/, "");

  // Fatia por seção primeiro; os blocos são separados dentro de cada uma.
  const secoes: Record<string, string[]> = { EMPRESA: [], ATENDIMENTO: [] };
  let atual: string | null = null;
  let buffer: string[] = [];

  const fechar = () => {
    if (atual) secoes[atual].push(buffer.join("\n"));
    buffer = [];
  };

  for (const linha of texto.split(/\r?\n/)) {
    const cabecalho = linha.match(SECAO);
    if (cabecalho) {
      fechar();
      atual = cabecalho[1].toUpperCase();
      continue;
    }
    if (SEPARADOR.test(linha)) {
      fechar();
      continue;
    }
    if (atual) buffer.push(linha);
  }
  fechar();

  if (secoes.EMPRESA.length === 0) {
    throw new Error(
      `${NOME_DO_ARQUIVO}: não achei a seção [EMPRESA]. ` +
        `Ela marca onde começam os fatos que a IA responde.`,
    );
  }

  const mapear = (nome: "EMPRESA" | "ATENDIMENTO") =>
    secoes[nome]
      .map((b, i) => interpretarBloco(b, nome, i))
      .filter((c): c is KnowledgeChunk => c !== null);

  const empresa = mapear("EMPRESA");
  const atendimento = mapear("ATENDIMENTO");

  if (empresa.length === 0) {
    throw new Error(
      `${NOME_DO_ARQUIVO}: a seção [EMPRESA] está vazia — a IA ficaria sem informação nenhuma.`,
    );
  }

  // Aviso, não erro: um bloco de comportamento com `perguntas:` provavelmente
  // está na seção errada, mas não impede o sistema de subir.
  for (const c of atendimento) {
    if (c.perguntas) {
      console.warn(
        `[conhecimento] "${c.title}" está em [ATENDIMENTO] mas tem "perguntas:". ` +
          `O campo só vale em [EMPRESA] — se esse bloco responde pergunta de cliente, mova-o.`,
      );
    }
  }

  return { empresa, atendimento };
}

const carregado = carregar();

/**
 * FATOS. Vão pro RAG (`npm run ingest`) e servem de fallback no prompt.
 *
 * Rode `npm run ingest` toda vez que mexer na seção [EMPRESA] — senão a busca
 * continua respondendo com a versão antiga.
 */
export const BASE_CONHECIMENTO: KnowledgeChunk[] = carregado.empresa;

/**
 * COMPORTAMENTO. Fica FIXO no prompt, sempre presente.
 *
 * Nunca vai pro RAG de propósito: regra de conduta não pode depender de ser
 * sorteada por similaridade. Se a IA só se comportasse bem quando a busca
 * trouxesse o texto certo, ela se comportaria mal de forma aleatória.
 */
export const DIRETRIZES: KnowledgeChunk[] = carregado.atendimento;
