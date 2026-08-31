-- Lembrete de véspera.
--
-- Marca no próprio agendamento quando o lembrete saiu. Sem isso, o job rodando
-- de hora em hora mandaria o mesmo lembrete várias vezes — o jeito mais rápido
-- de irritar um paciente que já ia comparecer.

alter table appointments
  add column if not exists lembrete_enviado_at timestamptz,
  add column if not exists confirmado_em timestamptz;

-- O job busca por data_hora numa janela e filtra os que ainda não receberam.
create index if not exists idx_appointments_lembrete
  on appointments(status, data_hora, lembrete_enviado_at);
