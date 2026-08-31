import { getCalendarClient, CALENDAR_ID } from "./googleCalendar.js";
import { config, TIMEZONE } from "../config.js";
import { EXPEDIENTE } from "../negocio/negocio.js";

// Disponibilidade por SLOTS EXPLÍCITOS.
//
// Inversão pedida pelo cliente: em vez de "todo o expediente menos o que está
// ocupado", a clínica marca no Google Calendar os eventos que representam vaga
// livre ("Horário disponível"), e a IA só pode oferecer esses.
//
// O motivo é operacional: são três cadeiras e a agenda vive cheia. Marcar as
// poucas folgas dá muito menos trabalho ao time do que manter todos os
// compromissos lançados — e o modelo anterior, se a agenda estivesse
// desatualizada, fazia a IA achar que o dia inteiro estava livre.
//
// Consequência importante: **sem evento marcado, não há horário para oferecer**.
// Isso é o comportamento certo — melhor a IA dizer que vai verificar do que
// marcar em cima de uma cadeira ocupada.
//
// Três cadeiras funcionam naturalmente: se o time criar três eventos livres às
// 10h, existem três vagas às 10h, e cada agendamento consome uma.

export interface SlotLivre {
  /** id do evento no Google — é ele que será convertido em agendamento. */
  eventId: string;
  /** "2026-08-21" no fuso da clínica. */
  data: string;
  /** "14:00" no fuso da clínica. */
  hora: string;
  inicio: Date;
  fim: Date;
}


/**
 * A vaga publicada cai dentro do expediente?
 *
 * Existe porque a publicação é manual: basta alguém errar o dia ao arrastar um
 * evento e a IA passa a oferecer horário com a clínica fechada. Apareceu na
 * prática — uma vaga foi parar num domingo. O sistema confia no time para saber
 * QUANDO tem cadeira livre, mas não para reescrever o horário de funcionamento.
 */
function dentroDoExpediente(inicio: Date, fim: Date): boolean {
  // getDay() é o dia local, e o processo roda fixado em Brasília (config.ts).
  const janela = EXPEDIENTE[inicio.getDay()];
  if (!janela) return false;

  const hIni = fmt(inicio, { hour: "2-digit", minute: "2-digit", hour12: false });
  const hFim = fmt(fim, { hour: "2-digit", minute: "2-digit", hour12: false });
  return hIni >= janela[0] && hFim <= janela[1];
}

function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, ...opts }).format(d);
}

function dataLocal(d: Date): string {
  return fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("-");
}

function horaLocal(d: Date): string {
  return fmt(d, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** O título do evento marca uma vaga livre? */
export function ehSlotLivre(titulo: string | null | undefined): boolean {
  if (!titulo) return false;
  const t = titulo
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return config.slots.palavrasChave.some((p) => t.includes(p));
}

/**
 * Vagas livres publicadas pelo time, dos próximos dias.
 *
 * Descarta o que já passou: um "horário disponível" de ontem, ou de hoje mais
 * cedo, não pode ser oferecido.
 */
export async function buscarSlotsLivres(diasAFrente = 14): Promise<SlotLivre[]> {
  const calendar = getCalendarClient();
  const agora = new Date();

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID(),
    timeMin: agora.toISOString(),
    timeMax: new Date(agora.getTime() + diasAFrente * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const slots: SlotLivre[] = [];
  for (const ev of res.data.items ?? []) {
    if (!ehSlotLivre(ev.summary)) continue;
    // Evento de dia inteiro não serve como horário de atendimento.
    if (!ev.start?.dateTime || !ev.end?.dateTime || !ev.id) continue;

    const inicio = new Date(ev.start.dateTime);
    if (inicio <= agora) continue;

    // A vaga vale o tempo do próprio evento. Um bloco de 4h criado achando que
    // "libera a tarde toda" viraria UMA vaga de 4 horas, não quatro de 1h — o
    // combinado com o time é um evento por vaga. O aviso serve pra flagrar isso
    // antes de virar paciente marcado em horário estranho.
    const fim = new Date(ev.end.dateTime);
    const minutos = Math.round((fim.getTime() - inicio.getTime()) / 60_000);
    if (Math.abs(minutos - config.slots.duracaoEsperadaMin) > 15) {
      console.warn(
        `[slots] "${ev.summary}" em ${dataLocal(inicio)} ${horaLocal(inicio)} dura ${minutos}min ` +
          `(esperado ~${config.slots.duracaoEsperadaMin}min). Vale conferir com a clínica — ` +
          `o combinado é um evento por vaga.`,
      );
    }

    if (!dentroDoExpediente(inicio, fim)) {
      console.warn(
        `[slots] IGNORADA: "${ev.summary}" em ${dataLocal(inicio)} ${horaLocal(inicio)} está fora do ` +
          `horário de atendimento (seg-sex 9h-19h, sáb 9h-17h, domingo fechado). ` +
          `Confira a agenda com a clínica.`,
      );
      continue;
    }

    slots.push({
      eventId: ev.id,
      data: dataLocal(inicio),
      hora: horaLocal(inicio),
      inicio,
      fim,
    });
  }
  return slots;
}

/** Agrupado por dia, no formato que a ferramenta do agente usa. */
export async function slotsPorDia(): Promise<Record<string, string[]>> {
  const slots = await buscarSlotsLivres();
  const porDia: Record<string, string[]> = {};
  for (const s of slots) {
    (porDia[s.data] ??= []).push(s.hora);
  }
  // Ordena e remove repetição de horário — três cadeiras livres às 10h aparecem
  // como um "10:00" só para o paciente; a segunda e a terceira vagas existem no
  // banco de slots e serão usadas se outro paciente marcar no mesmo horário.
  for (const dia of Object.keys(porDia)) {
    porDia[dia] = [...new Set(porDia[dia])].sort();
  }
  return porDia;
}

/** A vaga daquele dia e hora que ainda está livre, se houver. */
export async function acharSlot(data: string, hora: string): Promise<SlotLivre | null> {
  const slots = await buscarSlotsLivres();
  return slots.find((s) => s.data === data && s.hora === hora) ?? null;
}
