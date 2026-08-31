-- Dados que a clínica pede para agendar: nome completo, data de nascimento e
-- e-mail. Antes só existia o primeiro nome que o WhatsApp informa, que não serve
-- para prontuário nem para confirmar identidade na recepção.

alter table leads
  add column if not exists nome_completo text,
  add column if not exists data_nascimento date,
  add column if not exists email text;
