-- Trava RLS em todas as tabelas de cliente, sem nenhuma policy pra anon/authenticated.
-- O backend usa a service_role key (que ignora RLS), então isso não quebra nada —
-- só impede que a anon/publishable key consiga ler ou escrever essas tabelas
-- caso ela vaze ou seja usada em algum painel público no futuro.
-- Ver risco_supabase_rls_exposto na memória: já tivemos RLS desligado sem querer
-- em outro projeto — aqui nasce travado desde o início.
alter table leads enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table appointments enable row level security;
alter table clinic_documents enable row level security;
