import { config, TIMEZONE } from "../config.js";
import { supabase } from "../db/supabase.js";
import { gerarFollowUp } from "../agent/agent.js";
import { enviarHumanizado } from "../messaging/humanizado.js";
import type { MessagingProvider } from "../messaging/MessagingProvider.js";

// Retoma quem parou de responder no meio da conversa.
//
// Lead que some depois de perguntar preço ou no meio da escolha de horário é o
// caso mais comum de perda, e normalmente não volta sozinho. Uma mensagem no
// mesmo dia recupera parte disso.
//
// Regras deliberadas, porque follow-up automático é fácil de virar spam:
//
// - só quem NÃO agendou (quem já marcou não precisa ser cutucado);
// - só se a última mensagem foi da IA (se o lead falou por último, a bola é
//   nossa, e o problema seria outro);
// - no máximo `maximo` tentativas por conversa;
// - nunca fora do horário comercial da clínica — mensagem de clínica às 3h da
//   manhã é a melhor forma de queimar o número.

interface Candidata {
  conversationId: string;
  leadId: string;
  leadNome: string;
  leadTelefone: string;
}

/** Hora local de Brasília, independente do fuso do servidor. */
function horaLocal(d = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(d),
  );
}

function dentroDoHorarioPermitido(): boolean {
  const { horaInicio, horaFim } = config.followup;
  const h = horaLocal();
  return h >= horaInicio && h < horaFim;
}

/**
 * Procura conversas paradas. Uma consulta por conversa candidata seria pesado se
 * o volume crescesse, mas com 10–30 contatos/dia isso é irrelevante — e é bem
 * mais legível do que uma view com window function.
 */
async function buscarCandidatas(): Promise<Candidata[]> {
  const { aposMs, maximo } = config.followup;
  const limite = new Date(Date.now() - aposMs).toISOString();

  const { data: conversas, error } = await supabase
    .from("conversations")
    .select("id, lead_id, followups_enviados, leads(id, nome, telefone, status_lead)")
    .eq("status", "ativa")
    .lt("followups_enviados", maximo)
    .limit(200);
  if (error) throw error;

  const candidatas: Candidata[] = [];

  for (const c of conversas ?? []) {
    const lead = (c as any).leads;
    if (!lead || lead.status_lead === "agendado") continue;

    const { data: ultimas } = await supabase
      .from("messages")
      .select("direction, created_at")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: false })
      .limit(1);

    const ultima = ultimas?.[0];
    if (!ultima) continue;
    // Lead falou por último, ou ainda não deu o tempo de espera.
    if (ultima.direction !== "out" || ultima.created_at > limite) continue;

    candidatas.push({
      conversationId: c.id as string,
      leadId: lead.id,
      leadNome: lead.nome ?? "",
      leadTelefone: lead.telefone,
    });
  }

  return candidatas;
}

/** Marca a tentativa como consumida, para a conversa não voltar na fila. */
async function contabilizar(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc("incrementar_followup", { conversa_id: conversationId });
  if (error) console.error(`[followup] FALHA AO CONTABILIZAR ${conversationId}: ${error.message}`);
}

async function enviarFollowUp(messaging: MessagingProvider, c: Candidata): Promise<void> {
  const texto = await gerarFollowUp({
    leadId: c.leadId,
    leadNome: c.leadNome,
    leadTelefone: c.leadTelefone,
    conversationId: c.conversationId,
  });
  if (!texto) return;

  try {
    await enviarHumanizado(messaging, c.leadTelefone, texto);
  } catch (err) {
    const erro = (err as Error).message;

    // Número que não existe no WhatsApp nunca vai receber. Sem contabilizar
    // aqui, a conversa volta na fila a cada varredura e o follow-up se repete
    // indefinidamente — aconteceu: um lead com telefone inválido recebeu 11
    // tentativas em 3 dias, cada uma gastando uma chamada ao modelo, e o
    // contador ficou em zero o tempo todo porque a exceção pulava o incremento.
    if (/"exists"\s*:\s*false/.test(erro)) {
      await contabilizar(c.conversationId);
      console.warn(
        `[followup] ${c.leadTelefone} não existe no WhatsApp — desistindo. ` +
          `Confira o telefone de ${c.leadNome || "(sem nome)"}.`,
      );
      return;
    }

    // Falha temporária (rede, Evolution fora do ar): também contabiliza, senão
    // uma indisponibilidade de horas vira uma enxurrada de tentativas. Perder um
    // follow-up é menos grave do que insistir com o paciente.
    await contabilizar(c.conversationId);
    console.error(`[followup] falha ao enviar para ${c.leadTelefone}, tentativa consumida: ${erro}`);
    return;
  }

  await contabilizar(c.conversationId);
  console.log(`[followup] enviado para ${c.leadNome || c.leadTelefone}`);
}

/** Uma passada. Exportada separada pra poder ser chamada à mão em teste. */
export async function rodarFollowUps(messaging: MessagingProvider): Promise<number> {
  if (!config.followup.ativo) return 0;
  if (!dentroDoHorarioPermitido()) return 0;

  try {
    const candidatas = await buscarCandidatas();
    for (const c of candidatas) {
      try {
        await enviarFollowUp(messaging, c);
      } catch (err) {
        console.error(`[followup] erro em ${c.leadTelefone}: ${(err as Error).message}`);
      }
    }
    return candidatas.length;
  } catch (err) {
    console.error(`[followup] varredura falhou: ${(err as Error).message}`);
    return 0;
  }
}

/** Liga a varredura periódica. Chamado uma vez, no boot do servidor. */
export function iniciarFollowUps(messaging: MessagingProvider): void {
  const { ativo, aposMs, intervaloMs, maximo, horaInicio, horaFim } = config.followup;
  if (!ativo) {
    console.log("[followup] desligado (FOLLOWUP_ATIVO=false)");
    return;
  }

  console.log(
    `[followup] ligado — cutuca depois de ${Math.round(aposMs / 60000)}min de silêncio, ` +
      `no máximo ${maximo}x por conversa, entre ${horaInicio}h e ${horaFim}h, ` +
      `varrendo a cada ${Math.round(intervaloMs / 60000)}min`,
  );

  setInterval(() => {
    void rodarFollowUps(messaging);
  }, intervaloMs).unref?.();
}
