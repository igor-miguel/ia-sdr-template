import { getCalendarClient, CALENDAR_ID } from "./googleCalendar.js";
import { supabase } from "../db/supabase.js";
import { registrarConsultaAgendada } from "../crm/datacrazy.js";
import { config } from "../config.js";
import { acharSlot } from "./slotsDisponiveis.js";
import { LOCAL, SERVICO, IDENTIDADE } from "../negocio/negocio.js";

const CLINIC_ADDRESS = LOCAL.endereco;

const SLOT_MINUTES = SERVICO.duracaoMin;

interface BookParams {
  leadId: string;
  leadNome: string;
  leadTelefone: string;
  date: string; // "2026-08-12"
  time: string; // "09:00"
}

export async function bookAppointment({ leadId, leadNome, leadTelefone, date, time }: BookParams) {
  const calendar = getCalendarClient();
  const calendarId = CALENDAR_ID();

  const start = new Date(`${date}T${time}:00`);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);

  const corpo = {
    summary: `${SERVICO.nome} — ${leadNome}`,
    description: `${SERVICO.nome} — ${IDENTIDADE.nome}\nCliente: ${leadNome}\nTelefone: ${leadTelefone}\nEndereço: ${CLINIC_ADDRESS}`,
    location: CLINIC_ADDRESS,
  };

  // No modelo de slots explícitos, agendar é CONVERTER a vaga publicada pelo
  // time: o mesmo evento deixa de dizer "Horário disponível" e passa a ser a
  // avaliação do paciente. Criar um evento novo por cima deixaria a vaga viva na
  // agenda e ela seria oferecida de novo — duas pessoas na mesma cadeira.
  // Com três cadeiras, três eventos livres no mesmo horário são três vagas
  // independentes, e cada agendamento consome uma.
  let event;
  if (config.slots.explicito) {
    const slot = await acharSlot(date, time);
    if (!slot) {
      throw new Error(
        `Não há vaga publicada em ${date} às ${time}. O horário pode ter sido preenchido agora.`,
      );
    }
    event = await calendar.events.patch({
      calendarId,
      eventId: slot.eventId,
      requestBody: corpo,
    });
  } else {
    event = await calendar.events.insert({
      calendarId,
      requestBody: {
        ...corpo,
        start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" },
        end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" },
      },
    });
  }

  const { data: appointment, error } = await supabase
    .from("appointments")
    .insert({
      lead_id: leadId,
      google_event_id: event.data.id,
      data_hora: start.toISOString(),
      status: "agendado",
    })
    .select()
    .single();
  if (error) throw error;

  await supabase.from("leads").update({ status_lead: "agendado" }).eq("id", leadId);

  // Só aqui o lead entra no CRM — depois da reserva confirmada, não antes.
  // A função engole os próprios erros de propósito: o paciente já tem horário
  // marcado, e uma falha do CRM não pode derrubar o atendimento.
  await registrarConsultaAgendada({ nome: leadNome, telefone: leadTelefone, quando: start });

  return { appointment, googleEventId: event.data.id, start, end };
}

export async function rescheduleAppointment({
  appointmentId,
  googleEventId,
  date,
  time,
}: {
  appointmentId: string;
  googleEventId: string;
  date: string;
  time: string;
}) {
  const calendar = getCalendarClient();
  const calendarId = CALENDAR_ID();

  const start = new Date(`${date}T${time}:00`);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);

  await calendar.events.patch({
    calendarId,
    eventId: googleEventId,
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" },
    },
  });

  const { error } = await supabase
    .from("appointments")
    .update({ data_hora: start.toISOString(), status: "remarcado" })
    .eq("id", appointmentId);
  if (error) throw error;

  return { start, end };
}

export async function cancelAppointment({
  appointmentId,
  googleEventId,
}: {
  appointmentId: string;
  googleEventId: string;
}) {
  const calendar = getCalendarClient();
  const calendarId = CALENDAR_ID();

  await calendar.events.delete({ calendarId, eventId: googleEventId });

  const { error } = await supabase
    .from("appointments")
    .update({ status: "cancelado" })
    .eq("id", appointmentId);
  if (error) throw error;
}
