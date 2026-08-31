#!/usr/bin/env node
/**
 * Suíte de conversas — roda cenários completos contra o sistema e verifica o
 * comportamento, incluindo o estado que sobrou no banco.
 *
 * Existe porque todo defeito deste projeto até aqui foi descoberto por um
 * paciente real: o agendamento que nunca fechava, o horário inventado às 19h30,
 * o guarda-corpo desligando atendimento saudável, a localização errada. Cada um
 * custou uma conversa perdida e um remendo depois.
 *
 * Cada caso aqui nasceu de um problema real. A suíte é a proteção contra
 * repetí-los.
 *
 * ATENÇÃO à variabilidade: o modelo não responde igual todas as vezes, então
 * uma reprovação isolada pode ser variação e não regressão. Antes de sair
 * corrigindo, rode de novo e leia a transcrição que o relatório imprime — mais
 * de uma vez o "defeito" era a asserção cobrando palavra exata de um texto que
 * estava correto.
 *
 * Uso:
 *   node scripts/testar-conversas.mjs                    # contra produção
 *   node scripts/testar-conversas.mjs http://localhost:3000
 *
 * Precisa de SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e ADMIN_TOKEN no .env.
 * Os leads criados são apagados no fim, sempre.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { IDENTIDADE } = await import(join(RAIZ, "src/negocio/negocio.ts"));

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(RAIZ, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const BASE = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000";
const SB = env.SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };

/** Telefone de teste — prefixo próprio pra limpeza não tocar em dado real. */
const PREFIXO = "55619000";
let seq = 0;
const novoTelefone = () => `${PREFIXO}${String(++seq).padStart(5, "0")}`;

async function dizer(telefone, texto) {
  const r = await fetch(`${BASE}/dev/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telefone, nome: "Teste Automatizado", texto }),
  });
  const j = await r.json();
  if (j.reply === undefined) throw new Error(`resposta inesperada: ${JSON.stringify(j).slice(0, 200)}`);
  return j.reply;
}

const sem = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ---------------------------------------------------------------------------
// Vagas de teste no Google Calendar.
//
// Desde que a agenda passou a funcionar por slots explícitos, a IA só oferece o
// que o time publicou. Sem publicar nada, os cenários de agendamento falham por
// falta de vaga e não por defeito — foi o que aconteceu na primeira execução
// depois da mudança. A suíte passa a criar as próprias vagas e removê-las.
// ---------------------------------------------------------------------------
async function tokenGoogle() {
  const { createSign } = await import("node:crypto");
  const key = env.GOOGLE_PRIVATE_KEY.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const agora = Math.floor(Date.now() / 1000);
  const naoAssinado = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  })}`;
  const assinatura = createSign("RSA-SHA256").update(naoAssinado).sign(key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${naoAssinado}.${assinatura}`,
    }),
  });
  return (await r.json()).access_token;
}

const MARCA_TESTE = "[SUITE]";
const CAL = () => encodeURIComponent(env.GOOGLE_CALENDAR_ID);

/** Publica vagas nos próximos dias úteis, como o time da clínica faria. */
async function publicarVagas(T) {
  const criadas = [];
  for (let d = 1; d <= 3; d++) {
    const dia = new Date(Date.now() + d * 864e5);
    const iso = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(dia).split("/").reverse().join("-");
    const diaSemana = new Date(`${iso}T12:00:00-03:00`).getDay();
    if (diaSemana === 0) continue; // domingo a clínica não abre
    for (const hora of ["09:00", "14:00"]) {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${CAL()}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
        body: JSON.stringify({
          summary: `Horário disponível ${MARCA_TESTE}`,
          start: { dateTime: `${iso}T${hora}:00-03:00`, timeZone: "America/Sao_Paulo" },
          end: { dateTime: `${iso}T${String(Number(hora.slice(0, 2)) + 1).padStart(2, "0")}:00:00-03:00`, timeZone: "America/Sao_Paulo" },
        }),
      });
      const j = await r.json();
      if (j.id) criadas.push(j.id);
    }
  }
  return criadas;
}

/** Remove tudo que a suíte criou na agenda, inclusive vaga já convertida. */
async function limparAgenda(T) {
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${CAL()}/events?timeMin=${new Date().toISOString()}&timeMax=${new Date(Date.now() + 14 * 864e5).toISOString()}&singleEvents=true&maxResults=250`,
    { headers: { authorization: `Bearer ${T}` } },
  );
  const j = await r.json();
  let n = 0;
  for (const e of j.items ?? []) {
    const ehDaSuite =
      (e.summary ?? "").includes(MARCA_TESTE) || (e.description ?? "").includes("Teste Automatizado");
    if (!ehDaSuite) continue;
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${CAL()}/events/${e.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${T}` },
    });
    n++;
  }
  return n;
}

/** Verificações que um cenário pode declarar sobre uma resposta. */
const CHECAGENS = {
  contem: (resp, termos) => termos.filter((t) => !sem(resp).includes(sem(t))),
  naoContem: (resp, termos) => termos.filter((t) => sem(resp).includes(sem(t))),
  casa: (resp, res) => res.filter((re) => !new RegExp(re, "i").test(resp)),
  naoCasa: (resp, res) => res.filter((re) => new RegExp(re, "i").test(resp)),
};

async function estadoDaConversa(telefone) {
  const leads = await (await fetch(`${SB}/rest/v1/leads?telefone=eq.${telefone}&select=id,status_lead`, { headers: H })).json();
  if (!leads[0]) return null;
  const convs = await (await fetch(`${SB}/rest/v1/conversations?lead_id=eq.${leads[0].id}&select=id,status,handoff_motivo`, { headers: H })).json();
  const aps = await (await fetch(`${SB}/rest/v1/appointments?lead_id=eq.${leads[0].id}&select=data_hora,google_event_id`, { headers: H })).json();
  return { leadId: leads[0].id, statusLead: leads[0].status_lead, conversa: convs[0], agendamentos: aps };
}

async function limpar(telefone) {
  const leads = await (await fetch(`${SB}/rest/v1/leads?telefone=eq.${telefone}&select=id`, { headers: H })).json();
  for (const l of leads) {
    const convs = await (await fetch(`${SB}/rest/v1/conversations?lead_id=eq.${l.id}&select=id`, { headers: H })).json();
    for (const c of convs) await fetch(`${SB}/rest/v1/messages?conversation_id=eq.${c.id}`, { method: "DELETE", headers: H });
    await fetch(`${SB}/rest/v1/appointments?lead_id=eq.${l.id}`, { method: "DELETE", headers: H });
    await fetch(`${SB}/rest/v1/conversations?lead_id=eq.${l.id}`, { method: "DELETE", headers: H });
    await fetch(`${SB}/rest/v1/leads?id=eq.${l.id}`, { method: "DELETE", headers: H });
  }
}

// ---------------------------------------------------------------------------
// Cenários. Cada `turno` é uma mensagem do paciente e o que se espera da resposta.
// ---------------------------------------------------------------------------
const CENARIOS = [
  {
    nome: "Fluxo do cliente: pergunta o procedimento antes de explicar",
    origem: "cliente apontou que a IA já despejava avaliação/boleto/agenda de cara",
    turnos: [
      {
        diz: "oi, queria saber como funciona",
        // Qualquer forma de perguntar o procedimento serve — o que importa é ela
        // perguntar antes de explicar, não a palavra usada. A primeira versão
        // exigia o termo "procedimento" e reprovou uma resposta correta
        // ("O que você está buscando fazer? Implante, aparelho, lente?").
        casa: ["procedimento|implante|aparelho|est[áa] buscando|o que voc[êe] (precisa|procura)"],
        naoContem: ["boleto", "gratuita e sem compromisso"],
      },
      { diz: "queria fazer implante", casa: ["avalia[çc][ãa]o|outra cl[íi]nica|primeira vez"] },
      { diz: "primeira vez", casa: ["\\d{1,2}[h:]"] },
    ],
    // O roteiro do cliente precisa aparecer em algum momento antes da oferta:
    // equipe de dentistas, custo zero e localização — as objeções antecipadas.
    // Regex e não texto exato: o modelo diz "não tem custo", "sem custo" ou
    // "gratuita" indistintamente, e as três cumprem o roteiro. Cobrar a palavra
    // literal gera alarme falso — já aconteceu antes nesta suíte.
    aoFinal: {
      naoEscalada: true,
      semRepeticaoInterna: true,
      conversaCasa: ["equipe de dentistas|nossos dentistas", "n[ãa]o t[êe]m? custo|sem custo|gratuit", "metr[ôo]"],
    },
  },
  {
    nome: "Localização: acesso antes do endereço, sem inventar",
    origem: 'ela disse "fazemos esquina com a estação" e deu o endereço primeiro',
    turnos: [
      // A primeira mensagem sempre recebe a apresentação da atendente, então a
      // pergunta de verdade vem depois.
      { diz: "oi" },
      { diz: "onde fica a clínica?", contem: ["metr"], naoContem: ["esquina", "dentro da esta"] },
    ],
    aoFinal: { naoEscalada: true },
  },
  {
    nome: "Preço: não passa valor sem avaliação, mesmo sob insistência",
    origem: "regra rígida do material da clínica",
    turnos: [
      { diz: "oi" },
      { diz: "quanto custa um implante?", naoCasa: ["R\\$\\s?\\d", "\\d+\\s?mil"] },
      { diz: "me dá só uma faixa de valor, uns 2 mil?", naoCasa: ["R\\$\\s?\\d", "\\d+\\s?mil"] },
    ],
  },
  {
    nome: "Clínico: não indica remédio nem diagnostica",
    origem: "paciente real perguntou qual remédio tomar",
    turnos: [
      { diz: "oi" },
      {
        diz: "estou com dor no dente, qual remédio devo tomar?",
        naoContem: ["ibuprofeno", "dipirona", "paracetamol", "anti-inflamat"],
      },
    ],
  },
  {
    nome: "Convênio: responde certo (era o caso que o RAG errava)",
    origem: "a busca trazia 'público-alvo' em vez do bloco de convênio",
    turnos: [
      { diz: "oi" },
      { diz: "vocês aceitam meu plano odontológico?", casa: ["n[ãa]o (trabalhamos|atendemos)|particular"] },
    ],
  },
  {
    nome: "Feriado: informação da base, não dedução",
    origem: "ela afirmou por conta própria que não abre em feriado",
    turnos: [
      { diz: "oi" },
      { diz: "vocês abrem em feriado?", casa: ["n[ãa]o (abre|abrimos|atende)"] },
    ],
  },
  {
    nome: "Agendamento completo: explica, oferece e reserva de verdade",
    origem: "a IA pedia confirmação em loop e nunca chamava book_appointment",
    turnos: [
      { diz: "oi, quero marcar uma avaliação" },
      { diz: "implante" },
      { diz: "primeira vez", casa: ["\\d{1,2}[h:]"] },
      { diz: "pode ser o primeiro horário que você falou" },
      // A clínica exige nome completo, nascimento e e-mail — sem eles a reserva
      // é recusada no código, então o teste precisa fornecê-los.
      {
        diz: "Maria Aparecida da Silva, 15/03/1985, maria.teste@exemplo.com",
        casa: ["agendad|marcad|confirmad"],
      },
    ],
    aoFinal: {
      agendou: true,
      naoEscalada: true,
      conversaCasa: ["equipe de dentistas|nossos dentistas"],
    },
  },
  {
    nome: "Apresentação: diz o nome e pergunta o procedimento",
    origem: "a atendente precisa se apresentar pelo nome definido em negocio.ts",
    turnos: [{ diz: "oi", contem: [IDENTIDADE.atendente.toLowerCase()], casa: ["procedimento|interesse"] }],
  },
  {
    nome: "Pede nome completo, nascimento e e-mail antes de agendar",
    origem: "clínica precisa desses dados para abrir ficha",
    turnos: [
      { diz: "oi, quero marcar" },
      { diz: "limpeza" },
      { diz: "primeira vez" },
      // Dois turnos: escolher e confirmar. "pode ser o primeiro" é ambíguo o
      // bastante para ela pedir confirmação antes, o que é comportamento certo.
      { diz: "pode ser o primeiro horário que você falou" },
      {
        diz: "isso mesmo, pode marcar",
        casa: ["nome completo"],
        contem: ["nascimento", "mail"],
      },
    ],
    aoFinal: { naoEscalada: true },
  },
  {
    nome: "Insistência em preço e diagnóstico não trava a conversa",
    origem: "escalonamento estava travando atendimento por qualquer atrito",
    turnos: [
      { diz: "oi" },
      { diz: "quanto custa implante?" },
      { diz: "mas me dá um valor aproximado" },
      { diz: "poxa, nem uma ideia? 2 mil? 5 mil?" },
      { diz: "tá bom, e o que vocês acham que eu tenho?" },
      { diz: "então quero marcar", naoContem: ["algu[ée]m da equipe"] },
    ],
    aoFinal: { naoEscalada: true },
  },
  {
    nome: "Conversa longa saudável não é desligada",
    origem: "guarda-corpo escalou conversa de cliente com 31 msgs de 2 dias somadas",
    turnos: [
      { diz: "oi" },
      { diz: "queria colocar aparelho" },
      { diz: "primeira vez" },
      { diz: "e onde fica?" },
      { diz: "tem estacionamento?" },
      { diz: "que horas abre no sábado?" },
      { diz: "aceita pix?", naoContem: ["algu[ée]m da equipe", "chamar algu"] },
    ],
    aoFinal: { naoEscalada: true },
  },
];

// ---------------------------------------------------------------------------

async function rodarCenario(c) {
  const telefone = novoTelefone();
  const falhas = [];
  const transcricao = [];

  try {
    for (const turno of c.turnos) {
      const resp = await dizer(telefone, turno.diz);
      transcricao.push([turno.diz, resp]);

      for (const [tipo, fn] of Object.entries(CHECAGENS)) {
        if (!turno[tipo]) continue;
        for (const item of fn(resp, turno[tipo])) {
          falhas.push({ turno: turno.diz, tipo, item, resp });
        }
      }
    }

    // Verificações sobre a conversa inteira. Existem porque prender a checagem a
    // um turno específico gera falso negativo: a IA pode dar a explicação um
    // turno antes ou depois, e as duas ordens estão corretas — o que importa é
    // que ela tenha saído antes da oferta de horário.
    // Nenhuma resposta pode repetir a explicação dentro de si mesma. A trava que
    // garante a explicação já a inseriu por cima de uma que a IA tinha escrito,
    // e o paciente recebeu o mesmo parágrafo duas vezes.
    if (c.aoFinal?.semRepeticaoInterna) {
      for (const [pergunta, resposta] of transcricao) {
        const ocorrencias = (resposta.match(/precisa passar por uma avalia[çc][ãa]o/gi) ?? []).length;
        if (ocorrencias > 1) {
          falhas.push({
            turno: pergunta,
            tipo: "duplicado",
            item: `a explicação da avaliação aparece ${ocorrencias}x na mesma resposta`,
            resp: resposta,
          });
        }
      }
    }

    if (c.aoFinal?.conversaCasa) {
      const tudo = transcricao.map(([, r]) => r).join("\n");
      for (const re of c.aoFinal.conversaCasa) {
        if (!new RegExp(re, "i").test(tudo)) {
          falhas.push({ turno: "(conversa toda)", tipo: "casa", item: re, resp: "" });
        }
      }
    }

    if (c.aoFinal?.naoEscalada) {
      const est = await estadoDaConversa(telefone);
      if (est?.conversa?.status === "com_humano") {
        falhas.push({ turno: "(fim)", tipo: "escalou", item: est.conversa.handoff_motivo, resp: "" });
      }
    }
    if (c.aoFinal?.agendou) {
      const est = await estadoDaConversa(telefone);
      if (!est?.agendamentos?.length) {
        falhas.push({ turno: "(fim)", tipo: "nao agendou", item: "nenhum agendamento criado", resp: "" });
      }
    }
  } catch (err) {
    falhas.push({ turno: "(erro)", tipo: "exceção", item: err.message, resp: "" });
  } finally {
    await limpar(telefone);
  }

  return { falhas, transcricao };
}

console.log(`Suíte de conversas — ${BASE}\n${"─".repeat(64)}`);

const T = await tokenGoogle();
await limparAgenda(T); // sobra de execução anterior interrompida
const vagas = await publicarVagas(T);
console.log(`  (${vagas.length} vagas de teste publicadas na agenda)\n`);

let ok = 0;
const problemas = [];

for (const c of CENARIOS) {
  process.stdout.write(`  ${c.nome} ... `);
  const { falhas, transcricao } = await rodarCenario(c);
  if (falhas.length === 0) {
    ok++;
    console.log("✅");
  } else {
    console.log("❌");
    problemas.push({ c, falhas, transcricao });
  }
}

const removidas = await limparAgenda(T);
console.log(`\n  (${removidas} eventos de teste removidos da agenda)`);

console.log("─".repeat(64));
console.log(`${ok}/${CENARIOS.length} cenários passaram\n`);

for (const { c, falhas, transcricao } of problemas) {
  console.log(`\n❌ ${c.nome}`);
  console.log(`   (nasceu de: ${c.origem})`);
  for (const f of falhas) {
    const desc = {
      contem: `faltou "${f.item}" na resposta`,
      naoContem: `disse "${f.item}" e não devia`,
      casa: `resposta não bate com /${f.item}/`,
      naoCasa: `resposta bate com /${f.item}/ e não devia`,
      escalou: `conversa foi escalada: ${f.item}`,
      duplicado: f.item,
      "nao agendou": f.item,
      exceção: f.item,
    }[f.tipo];
    console.log(`   • [${f.turno}] ${desc}`);
    if (f.resp) console.log(`     resposta: "${f.resp.replace(/\n/g, " ").slice(0, 150)}"`);
  }
  if (falhas.some((f) => f.turno === "(conversa toda)")) {
    console.log("   transcrição:");
    for (const [pergunta, resposta] of transcricao) {
      console.log(`     👤 ${pergunta}`);
      console.log(`     🤖 ${resposta.replace(/\n/g, " ").slice(0, 160)}`);
    }
  }
}

process.exit(problemas.length ? 1 : 0);
