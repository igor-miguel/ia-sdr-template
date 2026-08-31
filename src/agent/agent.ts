import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { config, TIMEZONE } from "../config.js";
import { supabase } from "../db/supabase.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { montarContextoDaBase } from "../knowledge/retrieve.js";
import { toolDefinitions, executeTool, type ToolContext } from "./tools.js";
import type { MessagingProvider } from "../messaging/MessagingProvider.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

const MODEL = "gpt-4o";
const HISTORY_LIMIT = 20;
/** Janela do histórico. Mensagem mais velha que isso não entra no contexto. */
const HISTORY_HOURS = Number(process.env.HISTORICO_HORAS ?? 4);

export interface AgentTurnContext {
  leadId: string;
  leadNome: string;
  leadTelefone: string;
  conversationId: string;
}

/**
 * Histórico recente da conversa.
 *
 * Limitado por TEMPO, além da quantidade. Sem o corte temporal, a IA reagia a
 * assuntos encerrados horas ou dias antes: um paciente que de manhã perguntou
 * "estou com dor, que remédio tomo?" mandou "Ola" à tarde e recebeu "entendo
 * que você está com dor, vou chamar alguém da equipe" — respondendo a uma
 * mensagem que não existia mais na cabeça dele.
 *
 * A janela é curta de propósito: conversa de WhatsApp com clínica se resolve em
 * minutos, e contexto velho atrapalha mais do que ajuda.
 */
async function loadHistory(conversationId: string): Promise<ChatCompletionMessageParam[]> {
  const desde = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .gte("created_at", desde)
    .order("created_at", { ascending: true })
    .limit(HISTORY_LIMIT);
  if (error) throw error;

  return (data ?? []).map((m) => ({
    role: m.direction === "in" ? "user" : "assistant",
    content: m.content,
  }));
}

/**
 * Âncora temporal do turno. Sem isto o modelo não sabe que dia é hoje e passa a
 * inventar: num teste real, o lead pediu "quinta de manhã" e a IA ofereceu
 * "próxima quinta-feira, dia 17 de agosto" — que era a segunda-feira de hoje.
 * O prompt é estático (montado no import), então a data entra a cada turno.
 */
function contextoTemporal(): string {
  const agora = new Date();
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, ...opts }).format(agora);
  return [
    `## Data e hora de agora`,
    `Hoje é ${fmt({ weekday: "long", day: "2-digit", month: "long", year: "numeric" })}, ` +
      `${fmt({ hour: "2-digit", minute: "2-digit" })} (horário de Brasília).`,
    `A data de hoje no formato das ferramentas é ${fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("-")}.`,
    ``,
    `Use isto para converter o que o lead fala ("amanhã", "quinta", "semana que vem")`,
    `na data certa. NUNCA afirme o dia da semana de uma data sem conferir com o que`,
    `a ferramenta check_availability devolveu — ela já informa o dia da semana de cada data.`,
    `Se o lead pedir um período ("de manhã", "à tarde"), ofereça só horários daquele período:`,
    `manhã até 12:00, tarde das 12:00 às 18:00, fim de tarde depois das 18:00.`,
  ].join("\n");
}

async function saveMessage(conversationId: string, direction: "in" | "out", content: string) {
  const { error } = await supabase.from("messages").insert({ conversation_id: conversationId, direction, content });
  if (error) throw error;
}

/**
 * Gera a mensagem de retomada pra quem parou de responder.
 *
 * Escrita a partir do histórico real da conversa, não de um texto padrão: uma
 * pessoa que parou no meio da escolha de horário precisa ouvir algo diferente
 * de quem parou logo depois de perguntar o preço.
 *
 * Sem ferramentas de propósito — follow-up é só uma mensagem. Nada de reservar
 * horário por conta própria com o lead calado.
 */
export async function gerarFollowUp(ctx: AgentTurnContext): Promise<string> {
  const history = await loadHistory(ctx.conversationId);
  if (history.length === 0) return "";

  const instrucao = [
    "A conversa acima parou: o lead leu e não respondeu mais.",
    "Escreva UMA mensagem curta pra retomar, do jeito que uma recepcionista simpática mandaria.",
    "",
    "- Retome o ponto exato onde parou. Se estava escolhendo horário, ofereça o horário de novo.",
    "- Uma ou duas frases, no máximo. Sem 'passando aqui para saber se você ainda tem interesse'.",
    "- Não cobre resposta, não crie culpa, não pressione.",
    "- Não repita o que já foi dito na conversa com as mesmas palavras.",
    "- Facilite dizer não: deixe claro que ele pode responder depois, sem problema.",
    "",
    "Responda APENAS com o texto da mensagem, nada mais.",
  ].join("\n");

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${contextoTemporal()}` },
      ...history,
      { role: "system", content: await montarContextoDaBase(history.map((h) => h.content).join(" ")) },
      { role: "system", content: instrucao },
    ],
  });

  const texto = (response.choices[0].message.content ?? "").trim();
  if (texto) await saveMessage(ctx.conversationId, "out", texto);
  return texto;
}

export async function runAgentTurn(
  ctx: AgentTurnContext,
  userMessage: string,
  messaging: MessagingProvider,
): Promise<string> {
  await saveMessage(ctx.conversationId, "in", userMessage);

  const history = await loadHistory(ctx.conversationId);

  // Informações da clínica buscadas pela mensagem atual. Vão DEPOIS do histórico
  // e logo antes da pergunta, que é onde o modelo mais presta atenção.
  const contextoBase = await montarContextoDaBase(userMessage);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${contextoTemporal()}` },
    ...history,
    { role: "system", content: contextoBase },
    { role: "user", content: userMessage },
  ];

  const toolCtx: ToolContext = {
    leadId: ctx.leadId,
    leadNome: ctx.leadNome,
    leadTelefone: ctx.leadTelefone,
    conversationId: ctx.conversationId,
    messaging,
  };

  let response = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: toolDefinitions,
  });
  let choice = response.choices[0].message;

  while (choice.tool_calls && choice.tool_calls.length > 0) {
    messages.push({ role: "assistant", content: choice.content, tool_calls: choice.tool_calls });

    for (const toolCall of choice.tool_calls as ChatCompletionMessageToolCall[]) {
      let result: string;
      try {
        const input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        result = await executeTool(toolCall.function.name, input, toolCtx);
      } catch (err) {
        result = `Erro ao executar a ferramenta: ${(err as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }

    response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolDefinitions,
    });
    choice = response.choices[0].message;
  }

  const finalText = (choice.content ?? "").trim();

  await saveMessage(ctx.conversationId, "out", finalText);

  return finalText;
}
