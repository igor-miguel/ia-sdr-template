-- IA SDR — schema inicial
-- Aplicado em 2026-08-09 via Supabase Management API no projeto lnnytmpegreuiceydmuc.

create extension if not exists vector with schema extensions;

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  telefone text unique not null,
  nome text,
  origem text,
  status_lead text not null default 'novo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  canal text not null default 'whatsapp',
  status text not null default 'ativa',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  google_event_id text,
  data_hora timestamptz not null,
  status text not null default 'agendado' check (status in ('agendado', 'remarcado', 'cancelado', 'realizado')),
  created_at timestamptz not null default now()
);

-- embedding: 1024 dims (Voyage AI voyage-3 — ver src/knowledge/embeddings.ts).
-- Anthropic não tem endpoint de embeddings próprio; Voyage é o parceiro recomendado.
create table if not exists clinic_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  embedding extensions.vector(1024),
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_conversation on messages(conversation_id);
create index if not exists idx_conversations_lead on conversations(lead_id);
create index if not exists idx_appointments_lead on appointments(lead_id);
create index if not exists idx_leads_telefone on leads(telefone);
