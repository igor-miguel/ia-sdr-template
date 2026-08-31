import OpenAI from "openai";
import { config, TIMEZONE } from "../config.js";
import { supabase } from "../db/supabase.js";
import { IDENTIDADE } from "../negocio/negocio.js";

// Revisão diária das conversas.
//
// Toda noite o próprio modelo lê os atendimentos do dia e aponta onde a IA
// travou, onde perdeu lead, o que respondeu mal e o que faltou na base de
// conhecimento. O resultado vai pro Discord.
//
// A ideia é fechar o ciclo: hoje só se descobre problema quando alguém senta e
// lê 50 mensagens — foi assim que o bug do loop de agendamento apareceu, dias
// depois de existir. Isso passa a ser automático.
//
// IMPORTANTE: o relatório é uma sugestão para um humano ler e decidir. Nada é
// alterado automaticamente. Sistema que reescreve o próprio comportamento em
// produção pode "melhorar" na direção errada e ninguém percebe.

const openai = new OpenAI({ apiKey: config.openai.apiKey });

function hojeLocal(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .split("/")
    .reverse()
    .join("-");
}

function horaLocal(): number {
  return Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(
      new Date(),
    ),
  );
}

interface ConversaDoDia {
  telefone: string;
  nome: string;
  status: string;
  agendou: boolean;
  handoff: string | null;
  linhas: string[];
}

async function coletarConversasDoDia(dia: string): Promise<ConversaDoDia[]> {
  const { data: msgs, error } = await supabase
    .from("messages")
    .select("conversation_id, direction, content, created_at")
    .gte("created_at", `${dia}T00:00:00-03:00`)
    .lte("created_at", `${dia}T23:59:59-03:00`)
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (!msgs?.length) return [];

  const ids = [...new Set(msgs.map((m) => m.conversation_id))];
  const { data: convs } = await supabase
    .from("conversations")
    .select("id, status, handoff_motivo, leads(nome, telefone, status_lead)")
    .in("id", ids);

  return (convs ?? []).map((c: any) => ({
    telefone: c.leads?.telefone ?? "?",
    nome: c.leads?.nome ?? "sem nome",
    status: c.status,
    agendou: c.leads?.status_lead === "agendado",
    handoff: c.handoff_motivo ?? null,
    linhas: msgs
      .filter((m) => m.conversation_id === c.id)
      .map((m) => `${m.direction === "in" ? "Paciente" : "IA"}: ${m.content.replace(/\n/g, " ")}`),
  }));
}

const INSTRUCAO = `Você analisa a qualidade de uma IA que atende pacientes de uma clínica odontológica pelo WhatsApp e agenda avaliações.

Leia os atendimentos e produza um relatório CURTO e ACIONÁVEL, em português, com no máximo 12 linhas:

1. Uma linha de resumo (quantos atendimentos, quantos agendaram).
2. **Problemas**: onde a IA travou, repetiu, contradisse, inventou informação, ou perdeu um lead que estava perto de fechar. Cite a frase exata dela. Se não houve, diga "nenhum".
3. **Faltou na base**: pergunta de paciente que ela não soube responder ou respondeu vago — é o que o cliente precisa completar.
4. **Sugestão**: no máximo 2 ajustes concretos, em ordem de impacto.

Regras:
- Seja específico e curto. "Ela repetiu a oferta de horário 3x sem agendar" vale mais que "poderia melhorar a fluidez".
- Não elogie por elogiar. Se o dia foi bom, diga em uma linha e pare.
- Se um lead não agendou, tente identificar o motivo real na conversa.
- Nada de markdown pesado, é pra ler no celular.`;

async function analisar(conversas: ConversaDoDia[]): Promise<string> {
  const corpo = conversas
    .map((c, i) => {
      const marcas = [
        c.agendou ? "AGENDOU" : "não agendou",
        c.status === "com_humano" ? `passou pra humano (${c.handoff ?? "?"})` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `--- Atendimento ${i + 1} (${c.nome}) [${marcas}] ---\n${c.linhas.join("\n")}`;
    })
    .join("\n\n");

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: INSTRUCAO },
      { role: "user", content: corpo.slice(0, 60_000) },
    ],
  });
  return (r.choices[0]?.message?.content ?? "").trim();
}

async function enviarDiscord(texto: string): Promise<void> {
  const url = config.revisao.discordWebhook;
  if (!url) {
    console.log(`[revisão] sem DISCORD_WEBHOOK — relatório só no log:\n${texto}`);
    return;
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 2000 é o limite do Discord por mensagem.
    body: JSON.stringify({ content: texto.slice(0, 1900) }),
  });
  if (!r.ok) throw new Error(`Discord respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Uma passada. Exportada separada pra poder ser rodada à mão. */
export async function rodarRevisao(dia = hojeLocal()): Promise<string | null> {
  try {
    const conversas = await coletarConversasDoDia(dia);
    if (conversas.length === 0) {
      console.log(`[revisão] ${dia}: nenhum atendimento, nada a relatar`);
      return null;
    }

    const agendaram = conversas.filter((c) => c.agendou).length;
    const analise = await analisar(conversas);
    const cabecalho =
      `📋 **IA SDR ${IDENTIDADE.nome} — ${dia.split("-").reverse().join("/")}**\n` +
      `${conversas.length} atendimento(s) · ${agendaram} agendamento(s)\n\n`;

    await enviarDiscord(cabecalho + analise);
    console.log(`[revisão] ${dia}: relatório enviado (${conversas.length} conversas)`);
    return analise;
  } catch (err) {
    console.error(`[revisão] falhou: ${(err as Error).message}`);
    return null;
  }
}

/** Liga a checagem periódica; o filtro de hora decide quando de fato roda. */
export function iniciarRevisaoDiaria(): void {
  const { ativo, hora } = config.revisao;
  if (!ativo) {
    console.log("[revisão] desligada (REVISAO_ATIVA=false)");
    return;
  }

  console.log(`[revisão] ligada — relatório diário às ${hora}h no Discord`);

  let ultimoDia = "";
  // Mesma lógica do lembrete: checagem frequente em vez de intervalo longo, pra
  // um restart não fazer o ciclo pular a hora do relatório.
  setInterval(() => {
    const dia = hojeLocal();
    // Trava por dia contra relatório repetido. É em memória, então um restart
    // dentro da hora do envio pode gerar um segundo relatório — irritante, mas
    // muito melhor do que o silêncio de não enviar nenhum.
    if (horaLocal() === hora && dia !== ultimoDia) {
      ultimoDia = dia;
      void rodarRevisao(dia);
    }
  }, 10 * 60 * 1000).unref?.();
}
