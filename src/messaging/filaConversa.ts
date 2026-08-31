import { config } from "../config.js";

// Fila por contato. Existe por causa do delay humanizado: se a IA leva ~30s pra
// responder, mensagens que chegam nesse meio tempo precisam ser tratadas, ou a
// conversa vira duas IAs falando por cima uma da outra.
//
// Resolve duas situações:
//
// 1. Mensagens picadas ("oi" ... "queria marcar uma avaliação"): espera uma
//    janela curta por mais mensagens e responde tudo de uma vez, como uma pessoa
//    faria ao abrir o WhatsApp e ler as duas.
// 2. Mensagem que chega enquanto a IA ainda está respondendo: entra na fila e é
//    processada depois, nunca em paralelo pro mesmo contato.

interface Pendente {
  textos: string[];
  nome?: string;
  timer: NodeJS.Timeout;
}

const aguardando = new Map<string, Pendente>();
const processando = new Set<string>();

type Processador = (telefone: string, texto: string, nome?: string) => Promise<void>;

/**
 * Recebe uma mensagem e agenda o processamento. Retorna na hora — quem chama
 * (o webhook) não deve segurar a conexão esperando a IA responder, senão a
 * Evolution estoura o timeout e reenvia a mensagem.
 */
export function receberMensagem(
  telefone: string,
  texto: string,
  nome: string | undefined,
  processar: Processador,
): void {
  const existente = aguardando.get(telefone);
  if (existente) {
    clearTimeout(existente.timer);
    existente.textos.push(texto);
    existente.nome ??= nome;
    existente.timer = setTimeout(() => disparar(telefone, processar), config.humanizacao.janelaAgrupamentoMs);
    return;
  }

  aguardando.set(telefone, {
    textos: [texto],
    nome,
    timer: setTimeout(() => disparar(telefone, processar), config.humanizacao.janelaAgrupamentoMs),
  });
}

async function disparar(telefone: string, processar: Processador): Promise<void> {
  // Ainda respondendo a mensagem anterior: deixa na fila e reagenda. O timer
  // de agrupamento vira, aqui, um timer de "tenta de novo daqui a pouco".
  if (processando.has(telefone)) {
    const p = aguardando.get(telefone);
    if (p) p.timer = setTimeout(() => disparar(telefone, processar), config.humanizacao.janelaAgrupamentoMs);
    return;
  }

  const pendente = aguardando.get(telefone);
  if (!pendente) return;
  aguardando.delete(telefone);

  processando.add(telefone);
  try {
    await processar(telefone, pendente.textos.join("\n"), pendente.nome);
  } catch (err) {
    console.error(`[fila] erro ao responder ${telefone}: ${(err as Error).message}`);
  } finally {
    processando.delete(telefone);
  }
}
