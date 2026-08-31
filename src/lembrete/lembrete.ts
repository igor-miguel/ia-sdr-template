import { config, TIMEZONE } from "../config.js";
import { supabase } from "../db/supabase.js";
import { enviarHumanizado } from "../messaging/humanizado.js";
import type { MessagingProvider } from "../messaging/MessagingProvider.js";

// Lembrete na véspera da avaliação.
//
// É o recurso que mais reduz falta em clínica: parte das ausências não é
// desistência, é esquecimento. E quem não vai mais tem a chance de avisar, o
// que libera o horário para outro paciente em vez de deixar a cadeira vazia.
//
// O texto é montado em código, não gerado pelo modelo, de propósito: é uma
// mensagem transacional com data e hora: não pode ter variação criativa nem
// risco de alucinar o horário. O que vier de resposta aí sim vai para a IA,
// que já sabe remarcar e cancelar.

/** Data/hora do agendamento no fuso da clínica. */
function formatar(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, ...opts }).format(d);
}

function horaLocal(d = new Date()): number {
  return Number(formatar(d, { hour: "2-digit", hour12: false }));
}

function montarMensagem(nome: string, quando: Date): string {
  const primeiroNome = (nome || "").trim().split(/\s+/)[0];
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}! ` : "Oi! ";
  const diaSemana = formatar(quando, { weekday: "long" });
  const dia = formatar(quando, { day: "2-digit", month: "2-digit" });
  const hora = formatar(quando, { hour: "2-digit", minute: "2-digit" });

  // Só o lembrete, sem perguntar se consegue vir e sem oferecer remarcação.
  // Decisão do Igor: convidar a remarcar dá saída fácil pra quem ia comparecer.
  // Quem tiver imprevisto pede — e aí a IA remarca normalmente, porque a resposta
  // do paciente entra no fluxo comum do agente.
  return `${saudacao}Passando pra lembrar da sua avaliação amanhã, ${diaSemana} (${dia}), às ${hora} 😊`;
}

interface Pendente {
  id: string;
  data_hora: string;
  leadNome: string;
  leadTelefone: string;
}

/**
 * Agendamentos de amanhã que ainda não receberam lembrete.
 *
 * "Amanhã" é calculado no fuso da clínica: pegar a janela em UTC mandaria
 * lembrete errado para quem marcou cedo ou tarde.
 */
async function buscarPendentes(): Promise<Pendente[]> {
  const agora = new Date();
  const amanha = formatar(new Date(agora.getTime() + 24 * 60 * 60 * 1000), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .split("/")
    .reverse()
    .join("-");

  const { data, error } = await supabase
    .from("appointments")
    .select("id, data_hora, leads(nome, telefone)")
    .in("status", ["agendado", "remarcado"])
    .is("lembrete_enviado_at", null)
    .gte("data_hora", `${amanha}T00:00:00-03:00`)
    .lte("data_hora", `${amanha}T23:59:59-03:00`);
  if (error) throw error;

  return (data ?? [])
    .filter((a: any) => a.leads?.telefone)
    .map((a: any) => ({
      id: a.id,
      data_hora: a.data_hora,
      leadNome: a.leads.nome ?? "",
      leadTelefone: a.leads.telefone,
    }));
}

export interface ResultadoLembretes {
  rodou: boolean;
  motivo?: string;
  encontrados: number;
  enviados: number;
  falhas: { telefone: string; erro: string }[];
}

/**
 * Uma passada. `forcar` ignora a checagem de horário — usado pelo endpoint
 * administrativo, que existe para diagnosticar e para reenviar à mão quando a
 * janela das 18h é perdida (queda, deploy, etc.).
 */
export async function rodarLembretes(
  messaging: MessagingProvider,
  opts: { forcar?: boolean } = {},
): Promise<ResultadoLembretes> {
  const vazio: ResultadoLembretes = { rodou: false, encontrados: 0, enviados: 0, falhas: [] };

  if (!config.lembrete.ativo) return { ...vazio, motivo: "LEMBRETE_ATIVO=false" };
  if (!opts.forcar && horaLocal() !== config.lembrete.horaEnvio) {
    return { ...vazio, motivo: `fora da hora de envio (agora ${horaLocal()}h, configurado ${config.lembrete.horaEnvio}h)` };
  }

  try {
    const pendentes = await buscarPendentes();
    // Log em toda passada, inclusive quando não há nada: sem isso não dá pra
    // distinguir "a rotina não rodou" de "rodou e não achou ninguém" — foi
    // exatamente essa dúvida que travou o diagnóstico da primeira vez.
    console.log(`[lembrete] varredura às ${horaLocal()}h — ${pendentes.length} pendente(s)`);

    const resultado: ResultadoLembretes = { rodou: true, encontrados: pendentes.length, enviados: 0, falhas: [] };

    for (const p of pendentes) {
      try {
        await enviarHumanizado(messaging, p.leadTelefone, montarMensagem(p.leadNome, new Date(p.data_hora)));

        const { error } = await supabase
          .from("appointments")
          .update({ lembrete_enviado_at: new Date().toISOString() })
          .eq("id", p.id);
        // Sem a marca o lembrete sairia de novo na próxima varredura.
        if (error) console.error(`[lembrete] FALHA AO MARCAR ${p.id}: ${error.message}`);

        resultado.enviados++;
        console.log(`[lembrete] enviado para ${p.leadNome || p.leadTelefone}`);
      } catch (err) {
        const erro = (err as Error).message;
        resultado.falhas.push({ telefone: p.leadTelefone, erro });
        console.error(`[lembrete] erro em ${p.leadTelefone}: ${erro}`);

        // Número que não existe no WhatsApp nunca vai funcionar — cadastro com
        // dígito errado, por exemplo. Sem isso a varredura tentaria esse
        // agendamento às 18h de todo dia, para sempre. Falha temporária (rede,
        // Evolution fora do ar) continua sem marca, pra ser tentada de novo.
        if (/"exists"\s*:\s*false/.test(erro)) {
          await supabase
            .from("appointments")
            .update({ lembrete_enviado_at: new Date().toISOString() })
            .eq("id", p.id);
          console.warn(
            `[lembrete] ${p.leadTelefone} não existe no WhatsApp — marcado pra não tentar de novo. ` +
              `Confira o telefone do paciente ${p.leadNome || "(sem nome)"}.`,
          );
        }
      }
    }
    return resultado;
  } catch (err) {
    const erro = (err as Error).message;
    console.error(`[lembrete] varredura falhou: ${erro}`);
    return { ...vazio, rodou: true, motivo: `erro: ${erro}` };
  }
}

/** Liga a varredura periódica. Chamado uma vez, no boot. */
export function iniciarLembretes(messaging: MessagingProvider): void {
  const { ativo, horaEnvio } = config.lembrete;
  if (!ativo) {
    console.log("[lembrete] desligado (LEMBRETE_ATIVO=false)");
    return;
  }

  console.log(`[lembrete] ligado — avisa às ${horaEnvio}h sobre as avaliações do dia seguinte`);

  // A cada 10 minutos, não de hora em hora. Com intervalo de 1h, o ciclo conta a
  // partir do boot: um restart às 18h30 empurra os disparos para 19h30, 20h30...
  // e o lembrete do dia inteiro é perdido em silêncio. Foi o que aconteceu no
  // primeiro dia em produção. Com 10min há ~6 chances dentro da hora certa, e o
  // campo lembrete_enviado_at impede envio repetido.
  setInterval(() => {
    void rodarLembretes(messaging);
  }, 10 * 60 * 1000).unref?.();
}
