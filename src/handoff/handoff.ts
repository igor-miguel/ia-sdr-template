import { config, TIMEZONE } from "../config.js";
import { supabase } from "../db/supabase.js";
import type { MessagingProvider } from "../messaging/MessagingProvider.js";

// Passagem de bastão para a secretária humana.
//
// Antes disso, escalate_to_human só marcava o lead no banco: ninguém era
// avisado e a IA continuava respondendo por cima. Na prática, escalar não
// fazia nada — um lead ficou marcado "precisa_humano" e ninguém soube.
//
// Agora o handoff faz as quatro coisas que ele precisa fazer:
//   1. trava a IA naquela conversa (ela não responde mais);
//   2. avisa a secretária no WhatsApp, com o contexto pronto;
//   3. o paciente é avisado pela própria IA, na mesma mensagem;
//   4. fica registrado quem, quando e por quê.

/** Últimas mensagens, pra secretária entrar na conversa sabendo o que rolou. */
async function resumoDaConversa(conversationId: string, limite = 6): Promise<string> {
  const { data } = await supabase
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limite);

  return (data ?? [])
    .reverse()
    .map((m) => `${m.direction === "in" ? "Paciente" : "IA"}: ${m.content.replace(/\n/g, " ")}`)
    .join("\n");
}

export interface DadosHandoff {
  leadId: string;
  conversationId: string;
  leadNome: string;
  leadTelefone: string;
  motivo: string;
  /**
   * `true` tira a conversa do automático: a IA para de responder até alguém
   * destravar. Reservado para o que realmente exige gente — pedido explícito de
   * falar com uma pessoa, dor/emergência, reclamação.
   *
   * `false` só avisa a secretária e a IA continua atendendo. É o certo para
   * sinais de qualidade (guarda-corpo): eles indicam que a conversa PODE estar
   * indo mal, e travar o atendimento por suspeita já custou paciente esperando
   * dias por alguém que não veio.
   */
  travar?: boolean;
}

/**
 * Executa a passagem. Não lança: se a notificação falhar, o importante — travar
 * a IA e registrar — já aconteceu, e é melhor a secretária descobrir pelo painel
 * do que o paciente receber resposta automática de novo.
 */
export async function passarParaHumano(
  messaging: MessagingProvider,
  dados: DadosHandoff,
): Promise<void> {
  const { conversationId, leadId, leadNome, leadTelefone, motivo, travar = true } = dados;

  if (travar) {
    const { error } = await supabase
      .from("conversations")
      .update({ status: "com_humano", handoff_at: new Date().toISOString(), handoff_motivo: motivo })
      .eq("id", conversationId);
    if (error) throw error;

    await supabase.from("leads").update({ status_lead: "precisa_humano" }).eq("id", leadId);
    console.log(`[handoff] ${leadNome || leadTelefone} passou para humano — ${motivo}`);
  } else {
    // Só registra o motivo, sem tirar do automático.
    await supabase.from("conversations").update({ handoff_motivo: motivo }).eq("id", conversationId);
    console.warn(`[alerta] ${leadNome || leadTelefone} — ${motivo} (IA continua atendendo)`);
  }

  // 2. Avisa a secretária.
  const numero = config.handoff.secretariaWhatsapp;
  if (!numero) {
    console.warn("[handoff] SECRETARIA_WHATSAPP não configurado — ninguém foi avisado");
    return;
  }

  try {
    const agora = new Intl.DateTimeFormat("pt-BR", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());

    const resumo = await resumoDaConversa(conversationId);
    const texto =
      (travar
        ? `🔔 *Atendimento precisa de você* (${agora})\n\n`
        : `⚠️ *Fique de olho nesta conversa* (${agora})\n\n`) +
      `*Paciente:* ${leadNome || "sem nome"}\n` +
      `*WhatsApp:* wa.me/${leadTelefone.replace(/\D/g, "")}\n` +
      `*Motivo:* ${motivo}\n\n` +
      `*Últimas mensagens:*\n${resumo}\n\n` +
      (travar
        ? `_A IA parou de responder essa conversa. Fale direto com o paciente pelo link acima._`
        : `_A IA continua atendendo normalmente. Entre só se achar necessário._`);

    await messaging.sendText(numero, texto);
  } catch (err) {
    console.error(`[handoff] falhei em avisar a secretária: ${(err as Error).message}`);
  }
}

/**
 * Horas que uma conversa pode ficar parada com humano antes de a IA reassumir.
 *
 * Existe porque o handoff sem prazo virou armadilha: uma paciente ficou dias
 * esperando alguém que nunca entrou, e cada mensagem nova dela caía no vazio.
 * Silêncio indefinido é pior do que a IA voltar a atender — se a secretária
 * assumiu de fato, ela já respondeu bem antes disso.
 */
const HORAS_ATE_IA_REASSUMIR = Number(process.env.HANDOFF_EXPIRA_HORAS ?? 3);

/** A IA responde essa conversa, ou ela está nas mãos de um humano? */
export async function conversaEstaComHumano(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("conversations")
    .select("status, handoff_at")
    .eq("id", conversationId)
    .single();

  if (data?.status !== "com_humano") return false;

  const desde = data.handoff_at ? new Date(data.handoff_at).getTime() : 0;
  if (Date.now() - desde > HORAS_ATE_IA_REASSUMIR * 60 * 60 * 1000) {
    await supabase
      .from("conversations")
      .update({ status: "ativa", handoff_at: null })
      .eq("id", conversationId);
    console.warn(
      `[handoff] conversa ${conversationId} ficou ${HORAS_ATE_IA_REASSUMIR}h sem atendimento humano — ` +
        `IA reassumiu para o paciente não ficar sem resposta.`,
    );
    return false;
  }
  return true;
}
