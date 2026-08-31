import { getCalendarClient, CALENDAR_ID } from "./googleCalendar.js";
import { config } from "../config.js";
import { slotsPorDia } from "./slotsDisponiveis.js";
import { EXPEDIENTE } from "../negocio/negocio.js";
import { SERVICO } from "../negocio/negocio.js";

// Horário de atendimento — definido em src/negocio/negocio.ts (EXPEDIENTE).
// weekday: 0 = domingo ... 6 = sábado
// Derivado de EXPEDIENTE (src/negocio/negocio.ts) — uma janela por dia. Este
// módulo é o modelo ANTIGO de disponibilidade ("expediente menos o ocupado"),
// usado só quando SLOTS_EXPLICITOS=false. Ver slotsDisponiveis.ts.
const HORARIOS_ATENDIMENTO: Record<number, [string, string][]> = Object.fromEntries(
  Object.entries(EXPEDIENTE).map(([dia, janela]) => [Number(dia), janela ? [janela] : []]),
);

const SLOT_MINUTES = SERVICO.duracaoMin;
const STEP_MINUTES = 15;
const DAYS_AHEAD = 14;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// Data no fuso local (Brasília — ver TIMEZONE no config.ts), não em UTC.
// Usava toISOString().slice(0,10), que é sempre UTC: depois das 21h de Brasília
// isso devolvia o dia seguinte, e o filtro de "horários já passados" abaixo parava
// de casar com hoje — o agente passava a oferecer horário de hoje que já passou.
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface AvailabilityByDay {
  [date: string]: string[]; // "2026-08-12": ["09:00", "09:15", ...]
}

export async function checkAvailability(): Promise<AvailabilityByDay> {
  // Modelo novo (padrão): a IA só oferece o que o time publicou como evento
  // livre na agenda. Ver src/calendar/slotsDisponiveis.ts para o porquê.
  if (config.slots.explicito) return slotsPorDia();

  const calendar = getCalendarClient();
  const calendarId = CALENDAR_ID();

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + DAYS_AHEAD);

  const freebusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busy = freebusy.data.calendars?.[calendarId]?.busy ?? [];

  const busyByDay = new Map<string, [number, number][]>();
  for (const b of busy) {
    if (!b.start || !b.end) continue;
    const bStart = new Date(b.start);
    const bEnd = new Date(b.end);
    const key = dateKey(bStart);
    const arr = busyByDay.get(key) ?? [];
    arr.push([bStart.getHours() * 60 + bStart.getMinutes(), bEnd.getHours() * 60 + bEnd.getMinutes()]);
    busyByDay.set(key, arr);
  }

  const result: AvailabilityByDay = {};

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const dCopy = new Date(d);
    if (dCopy <= now && dateKey(dCopy) === dateKey(now)) {
      // ainda permite o dia de hoje, mas filtra horários já passados mais abaixo
    }
    const weekday = dCopy.getDay();
    const janelas = HORARIOS_ATENDIMENTO[weekday] ?? [];
    if (janelas.length === 0) continue;

    const key = dateKey(dCopy);
    const busySlots = busyByDay.get(key) ?? [];

    const disponiveis: string[] = [];
    for (const [inicioStr, fimStr] of janelas) {
      let blocos: [number, number][] = [[toMinutes(inicioStr), toMinutes(fimStr)]];

      for (const [oIni, oFim] of busySlots) {
        const novosBlocos: [number, number][] = [];
        for (const [bIni, bFim] of blocos) {
          if (oFim <= bIni || oIni >= bFim) {
            novosBlocos.push([bIni, bFim]);
          } else {
            if (oIni > bIni) novosBlocos.push([bIni, oIni]);
            if (oFim < bFim) novosBlocos.push([oFim, bFim]);
          }
        }
        blocos = novosBlocos;
      }

      for (const [bIni, bFim] of blocos) {
        for (let i = bIni; i + SLOT_MINUTES <= bFim; i += STEP_MINUTES) {
          const isToday = key === dateKey(now);
          const nowMinutes = now.getHours() * 60 + now.getMinutes();
          if (isToday && i <= nowMinutes) continue;
          disponiveis.push(toHHMM(i));
        }
      }
    }

    if (disponiveis.length > 0) result[key] = disponiveis;
  }

  return result;
}
