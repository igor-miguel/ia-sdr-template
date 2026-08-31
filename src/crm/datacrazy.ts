import { config, TIMEZONE } from "../config.js";

// Integração com o CRM DataCrazy. Escopo, definido pelo Igor: só o lead que
// FECHA agendamento vira negócio no CRM, direto na etapa "Agendado". Quem só
// conversou e não marcou não entra — não enche o funil de curioso.
//
// Usa o webhook de "Entrada de Negócios" e NÃO a API REST: a API exige plano
// Pro e a conta da clínica está no Starter (todos os endpoints respondem
// "Upgrade Plan"). O mesmo vale pro servidor MCP, que roda sobre essa API.
//
// As chaves do payload abaixo são exatamente os nomes mapeados na tela da
// integração no painel — mudar qualquer uma aqui quebra o mapeamento lá.

interface DadosAgendamento {
  nome: string;
  telefone: string;
  quando: Date;
}

/** Formato que o DataCrazy espera no campo de telefone: "+55 (61) 999998888". */
function formatarTelefone(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  const m = d.match(/^(\d{2})(\d{2})(\d{8,9})$/);
  return m ? `+${m[1]} (${m[2]}) ${m[3]}` : telefone;
}

function formatar(quando: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, ...opts }).format(quando);
}

/**
 * Chamado depois que a avaliação é reservada com sucesso. O CRM cria o lead (ou
 * reaproveita, se o telefone já existir) e abre o negócio na etapa configurada
 * no painel, com a tag IA-SDR.
 *
 * NUNCA lança: se o CRM estiver fora do ar ou mal configurado, o agendamento do
 * paciente já aconteceu e está no Google Calendar — derrubar o atendimento por
 * causa do CRM seria bem pior do que ficar sem o registro. Falha vira log.
 */
export async function registrarConsultaAgendada(dados: DadosAgendamento): Promise<void> {
  const url = config.datacrazy.webhookUrl;
  if (!url) return; // integração desligada

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Nome: dados.nome,
        Telefone: formatarTelefone(dados.telefone),
        Email: "",
        Origem: "IA SDR WhatsApp",
        "Data da consulta": formatar(dados.quando, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        "Dia da semana": formatar(dados.quando, { weekday: "long" }),
        Observacao: "Avaliacao agendada pela IA no WhatsApp",
      }),
    });

    const corpo = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${corpo.slice(0, 200)}`);

    console.log(`[datacrazy] negócio criado para ${dados.nome} (${dados.telefone})`);
  } catch (err) {
    console.error(
      `[datacrazy] não consegui registrar o agendamento de ${dados.nome}: ${(err as Error).message}`,
    );
  }
}
