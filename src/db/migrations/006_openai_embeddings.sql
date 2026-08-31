-- Troca de provedor: Voyage AI -> OpenAI (decisão do Igor, 2026-08-12, junto com o
-- agente indo pra OpenAI). text-embedding-3-small usa 1536 dims em vez das 1024 do voyage-3.
-- Tabela estava vazia (nunca rodamos ingest sem a VOYAGE_API_KEY), então é só recriar a coluna.
alter table clinic_documents drop column embedding;
alter table clinic_documents add column embedding extensions.vector(1536);

create or replace function match_clinic_documents (
  query_embedding extensions.vector(1536),
  match_count int default 4
)
returns table (
  id uuid,
  title text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    id,
    title,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from clinic_documents
  order by embedding <=> query_embedding
  limit match_count;
$$;
