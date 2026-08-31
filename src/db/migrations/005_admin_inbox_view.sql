-- View usada pelo dashboard admin pra listar conversas com a última mensagem,
-- sem precisar de N+1 queries do backend.
create or replace view v_admin_inbox as
select
  l.id as lead_id,
  l.nome,
  l.telefone,
  l.status_lead,
  c.id as conversation_id,
  c.status as conversation_status,
  (select content from messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as last_message,
  (select direction from messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as last_message_direction,
  (select created_at from messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as last_message_at
from leads l
join conversations c on c.lead_id = l.id
order by last_message_at desc nulls last;
