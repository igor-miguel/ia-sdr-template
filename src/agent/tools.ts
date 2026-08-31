import { TIMEZONE } from "../config.js";
import { checkAvailability } from "../calendar/availability.js";

import { bookAppointment, rescheduleAppointment, cancelAppointment } from "../calendar/booking.js";
import { supabase } from "../db/supabase.js";
import { passarParaHumano } from "../handoff/handoff.js";
import { EXPLICACAO } from "./garantirExplicacao.js";
import { ROTEIRO } from "../negocio/negocio.js";
import type { MessagingProvider } from "../messaging/MessagingProvider.js";

const escaparRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARCADOR_EXPLICACAO = new RegExp(
  ROTEIRO.marcadoresDaExplicacao.map(escaparRegex).join("|"),
  "i",
);

/**
 * Formata os dias para o agente. O dia da semana vai explícito: com só a data
 * ISO o modelo errava a conversão ("quinta" virou a segunda-feira de hoje) e
 * afirmava o dia errado pro lead. Os horários vêm separados por período porque
 * o pedido mais comum é "de manhã" / "à tarde".
 */
/** Qual turno priorizar, segundo a hora em que a conversa está acontecendo. */
function orientacaoDeTurno(): string {
  const horaAgora = Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(new Date()),
  );
  return horaAgora < 12
    ? "É MANHÃ agora: ofereça HOJE se houver vaga; não havendo, o próximo turno livre.\n"
    : "É TARDE agora: o realista é AMANHÃ, de manhã ou à tarde. Só ofereça hoje se ainda sobrar vaga com folga.\n";
}

function formatarDias(dias: [string, string[]][]): string {
  // "hoje" e "amanhã" marcados de forma explícita: o cliente quer que a oferta
  // priorize as próximas 48h, e o modelo escolhe melhor com o rótulo do que
  // tendo que deduzir a proximidade a partir da data.
  const iso = (d: Date) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(d)
      .split("/")
      .reverse()
      .join("-");
  const hoje = iso(new Date());
  const amanha = iso(new Date(Date.now() + 24 * 60 * 60 * 1000));


  return dias
    .map(([data, horarios]) => {
      const [ano, mes, dia] = data.split("-").map(Number);
      const semana = new Intl.DateTimeFormat("pt-BR", {
        weekday: "long",
        timeZone: TIMEZONE,
      }).format(new Date(ano, mes - 1, dia));
      const rotulo = data === hoje ? " [HOJE — prefira]" : data === amanha ? " [AMANHÃ — prefira]" : "";
      const manha = horarios.filter((h) => h < "12:00");
      const tarde = horarios.filter((h) => h >= "12:00");
      const parte = (label: string, hs: string[]) =>
        hs.length ? `${label}: ${hs.slice(0, 5).join(", ")}${hs.length > 5 ? "..." : ""}` : "";
      const partes = [parte("manhã", manha), parte("tarde", tarde)].filter(Boolean).join(" | ");
      return `${data} (${semana})${rotulo} -> ${partes}`;
    })
    .join("\n");
}

/** A explicação da avaliação já foi dada nesta conversa? */
async function explicacaoJaFoiDada(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .eq("direction", "out")
    .order("created_at", { ascending: false })
    .limit(20);

  // Termos que só aparecem na explicação — marcador barato de que ela já foi
  // dada. Definidos em ROTEIRO.marcadoresDaExplicacao (src/negocio/negocio.ts),
  // os mesmos que garantirExplicacao.ts usa.
  return (data ?? []).some((m) => MARCADOR_EXPLICACAO.test(m.content));
}


export interface ToolContext {
  leadId: string;
  leadNome: string;
  leadTelefone: string;
  conversationId: string;
  /** Necessário pro handoff avisar a secretária. */
  messaging: MessagingProvider;
}

// Formato de tool da OpenAI (Chat Completions "function calling") —
// { type: "function", function: { name, description, parameters } }.
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export const toolDefinitions: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Consulta horários livres para avaliação. Use UMA vez, antes de oferecer horário ao lead. " +
        "Se o lead citou um dia ('quinta', 'amanhã', 'dia 25'), passe esse dia em `data` para ver " +
        "só ele — sem isso você recebe vários dias e corre o risco de oferecer o dia errado. " +
        "NÃO chame de novo depois que o lead escolher um horário: nesse momento use book_appointment.",
      parameters: {
        type: "object",
        properties: {
          data: {
            type: "string",
            description:
              "Opcional. Dia específico no formato YYYY-MM-DD, quando o lead já indicou um dia.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "RESERVA DE VERDADE a avaliação no horário informado. É esta ferramenta que efetiva o " +
        "agendamento — sem chamá-la, NADA é marcado, por mais que a conversa pareça concluída. " +
        "Exige os dados do paciente: peça nome completo, data de nascimento e e-mail DEPOIS que ele " +
        "escolher o horário e ANTES de chamar esta ferramenta. Sem os três, a reserva é recusada. " +
        "NÃO chame check_availability de novo antes: você já tem a disponibilidade. " +
        "NUNCA pergunte 'posso confirmar?' duas vezes — se o lead já disse sim, colete os dados e reserve.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Data no formato YYYY-MM-DD" },
          time: { type: "string", description: "Horário no formato HH:MM (24h)" },
          nome_completo: { type: "string", description: "Nome completo do paciente, como ele informou" },
          data_nascimento: { type: "string", description: "Data de nascimento no formato YYYY-MM-DD" },
          email: { type: "string", description: "E-mail do paciente" },
        },
        required: ["date", "time", "nome_completo", "data_nascimento", "email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description: "Remarca a avaliação já agendada do lead atual para uma nova data/horário.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Nova data no formato YYYY-MM-DD" },
          time: { type: "string", description: "Novo horário no formato HH:MM (24h)" },
        },
        required: ["date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancela a avaliação já agendada do lead atual.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Passa a conversa para a secretária humana. A partir daí VOCÊ PARA de responder esse " +
        "paciente — use quando realmente não conseguir resolver, não como saída fácil. " +
        "Use SOMENTE em três casos: dor forte/urgência/emergência, reclamação sobre atendimento " +
        "anterior, ou pedido explícito de falar com uma pessoa. Não escale por não saber uma " +
        "informação (diga que vai confirmar), por falta de horário na agenda, nem por insistência " +
        "em preço ou diagnóstico. Ao chamar, avise o paciente na mesma resposta que alguém da " +
        "equipe vai continuar o atendimento.",
      parameters: {
        type: "object",
        properties: {
          motivo: {
            type: "string",
            description:
              "Por que precisa de humano, em uma frase — a secretária lê isso pra saber como entrar na conversa",
          },
        },
        required: ["motivo"],
      },
    },
  },
];

async function getActiveAppointment(leadId: string) {
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("lead_id", leadId)
    .in("status", ["agendado", "remarcado"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "check_availability": {
      const availability = await checkAvailability();
      const pedida = (input as { data?: string }).data;

      // Filtrar pelo dia pedido evita o erro que aparecia em conversa real: com a
      // lista de 7 dias na frente, o modelo oferecia sábado a quem pediu quinta.
      let dias = Object.entries(availability);
      if (pedida) {
        const doDia = dias.filter(([data]) => data === pedida);
        if (doDia.length > 0) {
          dias = doDia;
        } else {
          const proximos = dias.filter(([data]) => data > pedida).slice(0, 2);
          return (
            `Não há horário livre em ${pedida}. Ofereça uma alternativa e deixe claro que é outro dia.\n` +
            (proximos.length ? formatarDias(proximos) : "Sem horários nos próximos dias.")
          );
        }
      } else {
        dias = dias.slice(0, 7);
      }

      if (dias.length === 0) {
        // Sem vaga publicada. Instrução explícita para NÃO escalar: escalar trava
        // a conversa, e aí nem publicar vagas depois faz a IA voltar a atender —
        // o paciente fica preso esperando alguém que talvez não venha. A falta de
        // horário é temporária e não é motivo para tirar o atendimento do ar.
        return (
          "Não há horário disponível na agenda. Diga isso ao paciente de forma simples e direta — " +
          "que no momento não há horário disponível — e ofereça avisá-lo assim que abrir vaga. " +
          "NÃO use escalate_to_human por causa disso e siga atendendo normalmente."
        );
      }

      const horarios = orientacaoDeTurno() + formatarDias(dias);
      if (await explicacaoJaFoiDada(ctx.conversationId)) return horarios;

      return (
        "PARE. Você ainda não explicou como funciona nesta conversa, e NÃO PODE " +
        "oferecer horário antes disso.\n\n" +
        "Envie PRIMEIRO esta explicação (pode adaptar as palavras, mas mantenha TODO o " +
        "conteúdo dela):\n\n" +
        `"${EXPLICACAO}"\n\n` +
        "DEPOIS dela, na mesma resposta, ofereça duas destas opções:\n" +
        horarios
      );
    }

    case "book_appointment": {
      const { date, time, nome_completo, data_nascimento, email } = input as {
        date: string; time: string; nome_completo?: string; data_nascimento?: string; email?: string;
      };

      // A clínica exige os três para abrir ficha. Recusar aqui, e não confiar na
      // instrução, é o que garante que nenhum agendamento entre incompleto — o
      // mesmo princípio das outras travas deste arquivo.
      const faltando = [
        !nome_completo?.trim() && "nome completo",
        !data_nascimento?.trim() && "data de nascimento",
        !email?.trim() && "e-mail",
      ].filter(Boolean);
      if (faltando.length) {
        return (
          `RESERVA RECUSADA: falta ${faltando.join(", ")}. NÃO diga que está agendado. ` +
          `Peça ao paciente o que falta e só então chame esta ferramenta de novo.`
        );
      }

      // Trava contra horário inventado. Em teste real a IA ofereceu "hoje às
      // 19h30" com a clínica fechando às 19h — copiou a ESTRUTURA do roteiro
      // ("consigo um encaixe para HOJE às 16h") e preencheu com hora fabricada.
      // Instrução no prompt não basta: aqui a reserva é recusada de fato, e o
      // agente recebe de volta os horários que existem mesmo.
      const disponivel = await checkAvailability();
      const doDia = disponivel[date] ?? [];
      if (!doDia.includes(time)) {
        const alternativas = doDia.length
          ? `Horários livres em ${date}: ${doDia.slice(0, 6).join(", ")}`
          : `Não há nenhum horário livre em ${date}.`;
        return (
          `RESERVA RECUSADA: ${date} às ${time} não está disponível — ou está fora do ` +
          `horário de atendimento, ou já passou, ou está ocupado. NÃO diga ao paciente que ` +
          `está agendado. Ofereça um horário real da lista abaixo.\n${alternativas}`
        );
      }

      await supabase
        .from("leads")
        .update({
          nome_completo,
          data_nascimento,
          email,
          // O nome de exibição passa a ser o informado, não o apelido do WhatsApp.
          nome: nome_completo,
        })
        .eq("id", ctx.leadId);

      await bookAppointment({
        leadId: ctx.leadId,
        leadNome: nome_completo!,
        leadTelefone: ctx.leadTelefone,
        date,
        time,
      });
      return `Avaliação agendada com sucesso para ${date} às ${time}, em nome de ${nome_completo}.`;
    }

    case "reschedule_appointment": {
      const { date, time } = input as { date: string; time: string };
      const appointment = await getActiveAppointment(ctx.leadId);
      if (!appointment || !appointment.google_event_id) {
        return "Não encontrei nenhuma avaliação agendada pra esse lead pra remarcar.";
      }
      await rescheduleAppointment({
        appointmentId: appointment.id,
        googleEventId: appointment.google_event_id,
        date,
        time,
      });
      return `Avaliação remarcada com sucesso para ${date} às ${time}.`;
    }

    case "cancel_appointment": {
      const appointment = await getActiveAppointment(ctx.leadId);
      if (!appointment || !appointment.google_event_id) {
        return "Não encontrei nenhuma avaliação agendada pra esse lead pra cancelar.";
      }
      await cancelAppointment({ appointmentId: appointment.id, googleEventId: appointment.google_event_id });
      return "Avaliação cancelada com sucesso.";
    }

    case "escalate_to_human": {
      const { motivo } = input as { motivo: string };
      await passarParaHumano(ctx.messaging, {
        leadId: ctx.leadId,
        conversationId: ctx.conversationId,
        leadNome: ctx.leadNome,
        leadTelefone: ctx.leadTelefone,
        motivo,
      });
      return (
        "Conversa passada para a secretária humana, que já foi avisada. " +
        "Escreva UMA mensagem curta se despedindo e avisando que alguém da equipe vai continuar. " +
        "Depois dessa mensagem você não responde mais esse paciente."
      );
    }

    default:
      throw new Error(`Tool desconhecida: ${name}`);
  }
}
