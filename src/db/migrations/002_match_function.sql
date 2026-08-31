-- Função de busca por similaridade usada pelo RAG (src/knowledge/retrieve.ts)
create or replace function match_clinic_documents (
  query_embedding extensions.vector(1024),
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
