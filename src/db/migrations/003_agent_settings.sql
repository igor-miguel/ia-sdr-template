-- Guarda a parte editável do system prompt (tom/framework/condução da conversa),
-- separada da base de conhecimento (clinic_documents) e das regras rígidas que
-- ficam fixas no código. Editável pelo dashboard admin.
create table if not exists agent_settings (
  id int primary key default 1,
  instructions text not null,
  updated_at timestamptz not null default now(),
  constraint agent_settings_singleton check (id = 1)
);

-- RLS ligado, sem policy pra anon/authenticated — só service_role (usado pelo
-- backend) consegue ler/escrever. Ver risco_supabase_rls_exposto na memória:
-- toda tabela nova nasce trancada por padrão aqui.
alter table agent_settings enable row level security;
