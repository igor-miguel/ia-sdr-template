-- Passagem de bastão para atendimento humano.
--
-- conversations.status já existia com 'ativa'; agora também aceita 'com_humano',
-- que é o estado em que a IA para de responder aquela conversa.
--
-- O handoff NÃO expira sozinho de propósito: a IA voltar a responder no meio de
-- um atendimento humano seria pior do que a conversa ficar parada. A reativação
-- é manual (ver README / SPEC).

alter table conversations
  add column if not exists handoff_at timestamptz,
  add column if not exists handoff_motivo text;

create index if not exists idx_conversations_status on conversations(status);

-- Devolve uma conversa para a IA. Existe pra que reativar seja um comando só,
-- e não um UPDATE escrito na mão com risco de errar a cláusula where.
create or replace function devolver_para_ia(conversa_id uuid)
returns void
language sql
as $$
  update conversations
     set status = 'ativa', handoff_at = null, handoff_motivo = null
   where id = conversa_id;
$$;
