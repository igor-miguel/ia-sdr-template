import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { ensureLeadConversation } from "./db/leads.js";
import { runAgentTurn } from "./agent/agent.js";
import { LocalProvider } from "./messaging/LocalProvider.js";
import { EvolutionApiProvider } from "./messaging/EvolutionApiProvider.js";
import { enviarHumanizado } from "./messaging/humanizado.js";
import { receberMensagem } from "./messaging/filaConversa.js";
import { extrairConteudo } from "./messaging/midia.js";
import { iniciarFollowUps } from "./followup/followup.js";
import { iniciarLembretes } from "./lembrete/lembrete.js";
import { iniciarRevisaoDiaria } from "./revisao/revisaoDiaria.js";
import { conversaEstaComHumano, passarParaHumano } from "./handoff/handoff.js";
import { avaliarConversa } from "./guardrails/guardrails.js";
import { registrarMensagemRecebida } from "./db/leads.js";
import { garantirExplicacao } from "./agent/garantirExplicacao.js";
import { adminRoutes } from "./admin/routes.js";
import { IDENTIDADE } from "./negocio/negocio.js";

const app = Fastify({ logger: true });

const messaging = config.evolution.apiUrl ? new EvolutionApiProvider() : new LocalProvider();

// O painel precisa do provider pra poder disparar lembrete à mão.
await app.register(adminRoutes, { messaging });

/**
 * Compara dois telefones ignorando diferença de formato — código do país e o
 * nono dígito, que o WhatsApp às vezes inclui e às vezes não em número
 * brasileiro. Os últimos 8 dígitos são a parte estável.
 */
function mesmoNumero(a: string, b: string): boolean {
  const digitos = (s: string) => s.replace(/\D/g, "");
  return digitos(a).slice(-8) === digitos(b).slice(-8);
}

/** Trava de teste — ver ALLOWED_NUMBERS no config. Lista vazia = atende todos. */
function podeResponder(telefone: string): boolean {
  const permitidos = config.evolution.allowedNumbers;
  return permitidos.length === 0 || permitidos.some((n) => mesmoNumero(n, telefone));
}

if (config.evolution.allowedNumbers.length > 0) {
  app.log.warn(
    `MODO TESTE: a IA só responde a ${config.evolution.allowedNumbers.join(", ")}. ` +
      `Qualquer outro número é ignorado. Esvazie ALLOWED_NUMBERS pra atender todo mundo.`,
  );
}

// Endpoint de teste local — simula uma mensagem chegando, sem depender do WhatsApp.
// Body: { telefone: string, nome?: string, texto: string }
app.post("/dev/chat", async (request, reply) => {
  const { telefone, nome, texto } = request.body as { telefone: string; nome?: string; texto: string };
  const lead = await ensureLeadConversation(telefone, nome);
  const gerada = await runAgentTurn(
    { leadId: lead.leadId, leadNome: lead.leadNome, leadTelefone: lead.leadTelefone, conversationId: lead.conversationId },
    texto,
    messaging,
  );
  return reply.send({ reply: await garantirExplicacao(lead.conversationId, gerada) });
});

// Webhook da Evolution API (MESSAGES_UPSERT) — plugar quando a instância existir.
// Formato: ver reference_evolution_api na memória do Igor / doc da Evolution API.
app.post("/webhook/whatsapp", async (request, reply) => {
  const body = request.body as any;
  const message = body?.data;
  const telefone: string | undefined = message?.key?.remoteJid?.split("@")[0];
  if (!telefone || message?.key?.fromMe) {
    return reply.send({ ok: true });
  }

  // A notificação de handoff sai pelo número da IA, então a secretária pode
  // responder ali por reflexo. Sem isso ela viraria "lead", a IA responderia, e
  // no futuro sem allowlist ela apareceria no funil como paciente.
  if (config.handoff.secretariaWhatsapp && mesmoNumero(config.handoff.secretariaWhatsapp, telefone)) {
    app.log.info("mensagem da secretária no número da IA — ignorada (ela fala com o paciente direto)");
    return reply.send({ ok: true, ignored: "secretaria" });
  }

  if (!podeResponder(telefone)) {
    app.log.info(`ignorado: ${telefone} não está em ALLOWED_NUMBERS (modo teste)`);
    return reply.send({ ok: true, ignored: "numero_nao_liberado" });
  }

  // Áudio vira transcrição e imagem vira descrição antes de o agente ver — daqui
  // pra frente o sistema inteiro trabalha só com texto. Roda antes da fila
  // porque a transcrição leva alguns segundos e não pode segurar o webhook.
  const conteudo = await extrairConteudo(message);
  if (!conteudo) {
    app.log.info(`sem conteúdo aproveitável de ${telefone} (figurinha, mídia não suportada ou falha)`);
    return reply.send({ ok: true, ignored: "sem_conteudo" });
  }
  const texto = conteudo.texto;
  if (conteudo.origem !== "texto") {
    app.log.info(`${telefone} enviou ${conteudo.origem} -> "${texto.slice(0, 80)}"`);
  }

  // Responde o webhook na hora e processa depois: com o delay humanizado a
  // resposta leva ~30s, e segurar a conexão faria a Evolution estourar o
  // timeout e reenviar a mensagem (o paciente receberia tudo duplicado).
  receberMensagem(telefone, texto, message?.pushName, async (tel, textoAgrupado, nome) => {
    const lead = await ensureLeadConversation(tel, nome);

    // Conversa já passada para a secretária: a mensagem fica registrada (ela
    // precisa ver o histórico completo no painel), mas a IA não responde. Duas
    // vozes atendendo o mesmo paciente é pior do que demorar pra responder.
    if (await conversaEstaComHumano(lead.conversationId)) {
      await registrarMensagemRecebida(lead.conversationId, textoAgrupado);
      app.log.info(`${tel} está com atendimento humano — IA não respondeu`);
      return;
    }

    const gerada = await runAgentTurn(
      { leadId: lead.leadId, leadNome: lead.leadNome, leadTelefone: lead.leadTelefone, conversationId: lead.conversationId },
      textoAgrupado,
      messaging,
    );

    // Não sai oferta de horário sem o paciente saber como é a avaliação. Isso é
    // garantido aqui, no código, e não por instrução ao modelo — ver
    // agent/garantirExplicacao.ts.
    const respostaTexto = await garantirExplicacao(lead.conversationId, gerada);

    // Guarda-corpo: se a IA está repetindo a mesma resposta ou a conversa está
    // arrastando sem agendar, a secretária entra antes de o paciente desistir.
    // A resposta que ela gerou fica gravada (útil pra auditoria) mas não é
    // enviada — mandar de novo o que já não funcionou só piora.
    const veredito = await avaliarConversa(
      lead.conversationId,
      respostaTexto,
      lead.leadStatus === "agendado",
    );
    // O guarda-corpo AVISA, mas não tira a IA do ar. Ele detecta suspeita de
    // problema, não certeza: travar por suspeita já custou dois atendimentos
    // saudáveis interrompidos e uma paciente esperando dias. A secretária recebe
    // o alerta e entra se quiser; o paciente continua sendo atendido.
    if (veredito.escalar) {
      app.log.warn(`guarda-corpo: ${tel} — ${veredito.motivo}`);
      await passarParaHumano(messaging, {
        leadId: lead.leadId,
        conversationId: lead.conversationId,
        leadNome: lead.leadNome,
        leadTelefone: lead.leadTelefone,
        motivo: veredito.motivo,
        travar: false,
      });
    }

    await enviarHumanizado(messaging, tel, respostaTexto);
  });

  return reply.send({ ok: true });
});

// Identifica o que está rodando. Sem isso, "o deploy foi feito?" e "a correção
// não funcionou?" ficam indistinguíveis de fora — aconteceu mais de uma vez.
let VERSAO = "desconhecida";
try {
  VERSAO = readFileSync(new URL("versao.txt", import.meta.url), "utf8").trim();
} catch {
  /* build antigo, sem o arquivo */
}
app.get("/health", async () => ({ ok: true, versao: VERSAO, subiuEm: new Date().toISOString() }));

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`${IDENTIDADE.nome} — IA SDR rodando na porta ${config.port}`);
    iniciarFollowUps(messaging);
    iniciarLembretes(messaging);
    iniciarRevisaoDiaria();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
