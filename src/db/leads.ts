import { supabase } from "./supabase.js";

/**
 * Silêncio a partir do qual a próxima mensagem inicia uma conversa nova, em vez
 * de continuar a anterior.
 *
 * Começou em 12h e desceu para 4h depois de um caso real: o paciente voltou
 * 6h45 depois, caiu na conversa antiga e a IA respondeu à dor de dente que ele
 * tinha mencionado de manhã. Atendimento de clínica por WhatsApp se resolve em
 * minutos; quem some por 4h e volta está começando de novo.
 */
const HORAS_ATE_NOVA_CONVERSA = Number(process.env.HORAS_NOVA_CONVERSA ?? 4);

export interface LeadConversation {
  leadId: string;
  leadNome: string;
  leadTelefone: string;
  conversationId: string;
  /** 'novo' | 'agendado' | 'precisa_humano' — usado pelo guarda-corpo. */
  leadStatus: string;
}

// Garante lead + conversa ativa para um telefone, criando o que faltar.
// Idempotente o bastante pra ser chamado a cada mensagem recebida.
export async function ensureLeadConversation(telefone: string, nome?: string): Promise<LeadConversation> {
  let { data: lead, error } = await supabase.from("leads").select("*").eq("telefone", telefone).maybeSingle();
  if (error) throw error;

  if (!lead) {
    const { data: created, error: createError } = await supabase
      .from("leads")
      .insert({ telefone, nome: nome ?? null, origem: "whatsapp" })
      .select()
      .single();
    if (createError) throw createError;
    lead = created;
  } else if (nome && !lead.nome) {
    await supabase.from("leads").update({ nome }).eq("id", lead.id);
    lead.nome = nome;
  }

  // A conversa mais recente, seja qual for o status. Filtrar por 'ativa' aqui
  // furaria o handoff: uma conversa em 'com_humano' não seria encontrada, uma
  // nova seria criada no lugar, e a IA voltaria a responder por cima da
  // secretária — exatamente o que o handoff existe pra impedir.
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("*")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (convError) throw convError;

  let conversationId = conversation?.id;

  // Paciente que volta depois de muito tempo começa uma conversa NOVA.
  //
  // Sem isso o histórico antigo contamina o atendimento: um paciente que dez
  // dias antes tinha perguntado "estou com dor, que remédio tomo?" mandou um
  // "Bom dia, gostaria de agendar" e a IA respondeu passando para a equipe por
  // causa da dor — reagindo a uma mensagem de outra semana.
  //
  // Conversa em atendimento humano não é reaberta: quem assumiu continua com ela.
  if (conversationId && conversation?.status === "ativa") {
    const { data: ultima } = await supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const limite = Date.now() - HORAS_ATE_NOVA_CONVERSA * 60 * 60 * 1000;
    if (ultima && new Date(ultima.created_at).getTime() < limite) {
      const { data: nova, error: erroNova } = await supabase
        .from("conversations")
        .insert({ lead_id: lead.id, canal: "whatsapp", status: "ativa" })
        .select()
        .single();
      if (erroNova) throw erroNova;
      conversationId = nova.id;
      console.log(`[conversa] ${telefone} voltou depois de um tempo — conversa nova iniciada`);
    }
  }
  if (!conversationId) {
    const { data: created, error: createConvError } = await supabase
      .from("conversations")
      .insert({ lead_id: lead.id, canal: "whatsapp", status: "ativa" })
      .select()
      .single();
    if (createConvError) throw createConvError;
    conversationId = created.id;
  }

  return {
    leadId: lead.id,
    leadNome: lead.nome ?? "sem nome",
    leadTelefone: lead.telefone,
    conversationId,
    leadStatus: lead.status_lead ?? "novo",
  };
}

/**
 * Grava uma mensagem recebida sem acionar a IA. Usado quando a conversa está
 * com a secretária: o histórico precisa ficar completo no painel, mas ninguém
 * responde automaticamente.
 */
export async function registrarMensagemRecebida(conversationId: string, content: string): Promise<void> {
  const { error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, direction: "in", content });
  if (error) throw error;
}
