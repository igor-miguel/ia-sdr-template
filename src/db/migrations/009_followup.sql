-- Follow-up de quem parou de responder.
--
-- Controle por conversa, não por lead: a mesma pessoa pode voltar semanas depois
-- numa conversa nova, e aí o contador recomeça — o que é o comportamento certo.
--
-- `followups_enviados` também serve de trava contra o pior cenário desse tipo de
-- automação, que é insistir com quem já pediu pra parar.

alter table conversations
  add column if not exists followups_enviados int not null default 0,
  add column if not exists ultimo_followup_at timestamptz;

-- A varredura procura conversas ativas com poucos follow-ups; esse índice evita
-- varrer a tabela inteira quando o volume crescer.
create index if not exists idx_conversations_followup
  on conversations(status, followups_enviados);

-- Incremento atômico. Ler-somar-gravar pelo backend abriria janela pra duas
-- varreduras contarem o mesmo envio uma vez só e o lead ser cutucado duas vezes.
create or replace function incrementar_followup(conversa_id uuid)
returns void
language sql
as $$
  update conversations
     set followups_enviados = followups_enviados + 1,
         ultimo_followup_at = now()
   where id = conversa_id;
$$;
