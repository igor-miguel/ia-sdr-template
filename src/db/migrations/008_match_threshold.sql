-- Corte por similaridade no RAG.
--
-- A versão anterior de match_clinic_documents só recebia (query_embedding, match_count)
-- e devolvia sempre os N vizinhos mais próximos, por pior que fossem. Como o resultado
-- é injetado no contexto do agente, pergunta fora do escopo (ex.: "vocês fazem raio-x
-- do joelho?") trazia chunk irrelevante como se fosse resposta. Agora quem não passa
-- do threshold fica de fora, e o agente vê uma lista vazia.
--
-- Também remove a sobrecarga órfã de 1024 dims criada pela migration 002 (voyage-3):
-- desde a 006 usamos OpenAI com 1536 dims, e em Postgres `create or replace` com
-- assinatura diferente cria uma função nova em vez de substituir a antiga.

drop function if exists match_clinic_documents(extensions.vector(1024), int);
drop function if exists match_clinic_documents(extensions.vector(1536), int);

create or replace function match_clinic_documents (
  query_embedding extensions.vector(1536),
  match_count int default 4,
  match_threshold float default 0.0
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
  where 1 - (embedding <=> query_embedding) >= match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
