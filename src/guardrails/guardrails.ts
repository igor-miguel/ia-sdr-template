import { config } from "../config.js";
import { supabase } from "../db/supabase.js";

// Guarda-corpo: detecta quando a IA está enroscada e passa a conversa para a
// secretária antes que o paciente desista.
//
// Nasceu de um caso real: a IA pediu confirmação de horário, o paciente disse
// "Sim", e ela respondeu oferecendo outro dia — quatro vezes seguidas, sem nunca
// agendar. Ninguém percebeu até alguém ler a conversa inteira depois. Com esse
// guarda-corpo, na segunda repetição a secretária já teria entrado.
//
// Os sinais são objetivos de propósito. Não se pergunta ao modelo "você está
// indo bem?" — modelo perdido costuma achar que está indo bem.

/** Texto comparável: sem acento, sem pontuação, sem caixa, sem espaço duplo. */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Semelhança entre duas frases pela proporção de palavras em comum (Jaccard).
 * Simples de propósito: o que se quer pegar é a IA repetindo a mesma ideia com
 * pequenas variações, e não paráfrase distante.
 */
export function semelhanca(a: string, b: string): number {
  const pa = new Set(normalizar(a).split(" ").filter((p) => p.length > 3));
  const pb = new Set(normalizar(b).split(" ").filter((p) => p.length > 3));
  if (pa.size === 0 || pb.size === 0) return 0;

  let comuns = 0;
  for (const p of pa) if (pb.has(p)) comuns++;
  return comuns / new Set([...pa, ...pb]).size;
}

/**
 * Frases com que a IA oferece horário ou pede confirmação de agendamento.
 *
 * Existe porque comparar palavras não funcionou: no caso real que originou este
 * módulo, "Posso reservar esse horário pra você?" e "Que tal às 10:00 da manhã?"
 * têm quase nenhuma palavra em comum, mas são a MESMA tentativa repetida. O que
 * se repete é a intenção, não o texto — então é a intenção que se detecta.
 */
const PADROES_FECHAMENTO = [
  /posso (reservar|confirmar|agendar|marcar)/i,
  /quer que eu (agende|reserve|marque|veja)/i,
  /que tal (às|as|no dia)/i,
  /temos? (um )?hor[áa]rio/i,
  /hor[áa]rios? dispon[íi]ve/i,
  /posso (te )?colocar/i,
];

/** Um horário concreto: "13:00", "9h", "às 10h30". */
const HORARIO_CONCRETO = /\b\d{1,2}\s?(:\d{2}|h\d{0,2})\b/;

/**
 * Tentativa de FECHAR um horário específico — não o convite genérico a agendar.
 *
 * A distinção é o que separa travamento de conversa saudável, e custou um falso
 * positivo em produção: "Quer que eu veja um horário?" é como a IA convida pra
 * agendar em toda conversa normal, e contar isso fazia o guarda-corpo escalar
 * atendimentos que estavam indo bem. Só conta quando há um horário concreto na
 * mensagem — aí sim ela está tentando fechar, e repetir significa que não fechou.
 */
function ehTentativaDeFechamento(texto: string): boolean {
  return HORARIO_CONCRETO.test(texto) && PADROES_FECHAMENTO.some((p) => p.test(texto));
}

export interface Veredito {
  escalar: boolean;
  motivo: string;
}

const OK: Veredito = { escalar: false, motivo: "" };

/**
 * Avalia se a conversa deve sair do automático, olhando a resposta que a IA
 * acabou de gerar contra o que ela já disse.
 *
 * Roda depois de gerar e antes de enviar — só assim dá pra comparar a resposta
 * nova com as anteriores.
 */
export async function avaliarConversa(
  conversationId: string,
  respostaProposta: string,
  leadJaAgendou: boolean,
): Promise<Veredito> {
  if (!config.guardrails.ativo) return OK;
  // Quem já agendou pode conversar à vontade: o objetivo foi cumprido.
  if (leadJaAgendou) return OK;

  // Só o que foi trocado nas últimas horas. Um lead que volta dias depois soma
  // mensagens no mesmo registro de conversa, e contar o relacionamento inteiro
  // escalava atendimento saudável: aconteceu com um paciente que voltou no
  // terceiro dia e bateu 31 mensagens acumuladas numa conversa que ia bem.
  const desde = new Date(Date.now() - config.guardrails.janelaHoras * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return OK; // guarda-corpo com defeito não pode derrubar atendimento

  const mensagens = data ?? [];
  const daIA = mensagens.filter((m) => m.direction === "out").map((m) => m.content);

  // 1. Travou no fechamento: ofereceu horário / pediu confirmação várias vezes
  // e o agendamento não saiu. É o sinal mais valioso — o lead está com a mão na
  // maçaneta e não consegue entrar.
  if (ehTentativaDeFechamento(respostaProposta)) {
    const tentativas =
      1 + daIA.slice(0, config.guardrails.janelaFechamento).filter(ehTentativaDeFechamento).length;
    if (tentativas >= config.guardrails.tentativasFechamento) {
      return {
        escalar: true,
        motivo: `a IA ofereceu horário ${tentativas}x e o agendamento não saiu — travou no fechamento`,
      };
    }
  }

  // 2. Repetição literal: a resposta nova é quase igual a algo que ela acabou de
  // dizer. Pega o caso mais óbvio, quando ela repete quase palavra por palavra.
  //
  // Só vale em conversa que já andou e em respostas de tamanho real. No começo é
  // normal e correto repetir: paciente que manda "oi" e depois "bom dia" recebe
  // a mesma saudação duas vezes, e isso não é travamento — foi um falso positivo
  // em produção que escalou um atendimento saudável.
  const conversaAndou = mensagens.length >= config.guardrails.minMensagensParaRepeticao;
  const respostaSubstancial = respostaProposta.length >= config.guardrails.minTamanhoRepeticao;
  const recentes = conversaAndou && respostaSubstancial
    ? daIA.slice(0, config.guardrails.janelaRepeticao).filter((m) => m.length >= config.guardrails.minTamanhoRepeticao)
    : [];
  const parecidas = recentes.filter(
    (m) => semelhanca(m, respostaProposta) >= config.guardrails.limiteSemelhanca,
  ).length;
  if (parecidas >= config.guardrails.repeticoesParaEscalar) {
    return {
      escalar: true,
      motivo: "a IA repetiu a mesma resposta várias vezes sem resolver — provável travamento",
    };
  }

  // 3. Conversa arrastando sem chegar a lugar nenhum — dentro da janela.
  if (mensagens.length >= config.guardrails.maxMensagensSemAgendar) {
    return {
      escalar: true,
      motivo: `${mensagens.length} mensagens nas últimas ${config.guardrails.janelaHoras}h sem agendamento`,
    };
  }

  return OK;
}

// A mensagem de transição saiu junto com a mudança: o guarda-corpo não
// interrompe mais o atendimento, só avisa a secretária. Quem se despede do
// paciente é a própria IA, quando ela decide escalar de verdade.
