# IA SDR para WhatsApp

Atendente virtual que conversa no WhatsApp, qualifica o lead, responde dúvida
consultando uma base de conhecimento própria e **agenda de verdade** numa agenda
do Google — sem aprovação humana no meio.

Foi construído para uma clínica, rodou em produção com atendimento real, e cada
regra estranha que você encontrar no código nasceu de um atendimento que deu
errado. Os comentários explicam qual.

---

## O que já vem pronto

| | |
|---|---|
| **Conversa** | WhatsApp via Evolution API, com digitação, pausa entre balões e agrupamento de mensagens picotadas |
| **Áudio e imagem** | áudio transcrito (Whisper); imagem descrita sem opinar sobre ela |
| **Base de conhecimento** | RAG com pgvector — responde preço, endereço, horário, o que atende |
| **Agenda** | consulta vagas reais, reserva, remarca e cancela no Google Calendar |
| **Follow-up** | quem sumiu recebe UMA retomada, só em horário comercial |
| **Lembrete** | véspera do compromisso |
| **Handoff** | trava a IA e chama um humano por WhatsApp, com resumo e link |
| **Guarda-corpo** | escala sozinho se a IA travar no fechamento ou repetir resposta |
| **Painel** | `/admin` com visão geral e caixa de entrada das conversas |
| **Revisão diária** | relatório das conversas do dia num canal do Discord |
| **Suíte de testes** | `npm test` roda conversas completas contra o sistema |

---

## Configurar: você edita 2 lugares

**1. `src/negocio/negocio.ts`** — todo o conteúdo: nome, roteiro comercial,
endereço, expediente, base de conhecimento. É um arquivo só, comentado passo a
passo. Vem preenchido com um exemplo fictício pra você ver rodando antes de trocar.

**2. `.env`** — as credenciais. Copie de `.env.example`, que explica onde
conseguir cada uma.

Fora desses dois, o código não deveria precisar de mudança.

---

## Instalar

```bash
npm install
cp .env.example .env     # e preencha
```

**Banco** — crie um projeto no [Supabase](https://supabase.com), ative a extensão
`vector` (Database > Extensions) e rode os arquivos de `src/db/migrations/` na
ordem numérica, pelo SQL Editor.

**Base de conhecimento** — depois de editar `negocio.ts`:

```bash
npm run ingest
```

Rode isso **toda vez** que mexer em `BASE_CONHECIMENTO`. Sem isso a IA continua
respondendo com o conteúdo antigo.

**Subir**

```bash
npm run build && npm start      # produção
npm run dev                     # desenvolvimento
npm run chat                    # conversar pelo terminal, sem WhatsApp
```

---

## Antes de ligar no WhatsApp

1. Deixe `ALLOWED_NUMBERS` preenchido com o seu número. A IA ignora todo mundo
   menos você. Só esvazie depois de testar conversa completa.
2. Publique vagas na agenda (veja abaixo) — **sem vaga publicada a IA não agenda
   ninguém**.
3. Rode `npm test`. São conversas completas de ponta a ponta, incluindo o que
   sobrou no banco. **Rode sempre antes de subir mudança.**
4. Converse você mesmo, por 20 ou 30 mensagens. Teste de 3 turnos não acha nada:
   o pior defeito que este sistema já teve — a IA pedindo confirmação em loop e
   nunca agendando — só apareceu numa conversa longa.

---

## Como a agenda funciona

O time **publica as vagas** no Google Calendar: um evento por vaga, com
"disponível" no título (ex.: "Horário disponível"). A IA só oferece essas.

Agendar não cria um evento novo — **converte** o evento da vaga, trocando o
título. Se criasse por cima, a vaga continuaria publicada e seria oferecida
outra vez, com duas pessoas no mesmo horário.

Três atendentes livres às 10h = três eventos às 10h = três vagas. Cada
agendamento consome uma.

**Consequência que precisa estar combinada com o time: publicar vaga vira rotina
diária.** Sem evento publicado, a IA responde tudo, conversa bem e não marca
ninguém.

O sistema descarta vaga fora do `EXPEDIENTE` definido em `negocio.ts` — proteção
contra alguém arrastar um evento pro domingo sem querer.

---

## Duas lições que valem mais que o código

**1. Comportamento que o negócio exige não pode depender de instrução ao modelo.**

A reclamação nº 1 do cliente resistiu a três reescritas de prompt. Só foi
resolvida inspecionando a resposta antes de enviar
(`src/agent/garantirExplicacao.ts`). Mesmo caso da trava que impede horário
inventado (`src/calendar/booking.ts` confere contra a agenda real e recusa).

Se algo **tem** que acontecer, ponha no código. O prompt é sugestão.

**2. Descrição de ferramenta é prompt.**

Uma condicional mal escrita na descrição de `book_appointment` ("só chame depois
de confirmar...") fez o modelo reconsultar a agenda toda vez e nunca fechar:
50 mensagens, zero agendamento. Escreva a descrição da tool com o mesmo cuidado
do prompt.

---

## Operação

`GET /health` devolve o commit em execução — sem isso, "o deploy foi feito?" e
"a correção falhou?" ficam indistinguíveis.

```bash
git pull && npm install && npm run build && pm2 restart ia-sdr
```

O `&&` importa: sem ele um build quebrado reinicia o app com a versão velha e
parece que a correção não funcionou.

**Ponto cego conhecido:** se o saldo da OpenAI zerar, a IA para de responder
qualquer pessoa e o `/health` continua verde — o erro só aparece quando alguém
manda mensagem. Deixe o billing automático ligado.

---

## Estrutura

```
src/
  negocio/negocio.ts     ← VOCÊ EDITA AQUI (conteúdo, roteiro, base)
  agent/                 agente, ferramentas, prompt, garantias
  calendar/              disponibilidade, vagas publicadas, reserva
  knowledge/             RAG: embeddings, ingestão, busca
  messaging/             WhatsApp, humanização, mídia
  followup/ lembrete/ handoff/ guardrails/ revisao/
  admin/                 painel
  db/migrations/         schema (rodar na ordem)
scripts/
  testar-conversas.mjs   npm test
  publicar-vagas.mjs     publica vagas de teste na agenda
```

**Stack:** Node + TypeScript + Fastify · Supabase/pgvector · OpenAI · Google
Calendar · Evolution API.
