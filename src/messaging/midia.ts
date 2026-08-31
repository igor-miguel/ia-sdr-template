import OpenAI from "openai";
import { config } from "../config.js";

// Paciente manda áudio. Muito. Numa clínica brasileira, ignorar áudio é ignorar
// boa parte dos leads — e o pior é que o silêncio parece descaso da clínica.
//
// Este módulo transforma áudio e imagem em texto antes de o agente ver a
// mensagem, de forma que o resto do sistema continua trabalhando só com texto.

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Baixa a mídia pela Evolution API.
 *
 * Tenta dois formatos de corpo porque versões diferentes da Evolution esperam
 * coisas diferentes: umas querem só a chave da mensagem, outras o objeto inteiro
 * que veio no webhook. Errar o formato devolve 400 e o áudio do paciente se
 * perde, então é mais barato tentar os dois do que depender da versão instalada.
 */
async function baixarMidia(
  messageId: string,
  mensagemCompleta?: unknown,
): Promise<{ base64: string; mimetype: string } | null> {
  const { apiUrl, apiKey, instance } = config.evolution;

  const tentativas: { nome: string; corpo: unknown }[] = [
    { nome: "key", corpo: { message: { key: { id: messageId } }, convertToMp4: false } },
  ];
  if (mensagemCompleta) {
    tentativas.push({ nome: "mensagem completa", corpo: { message: mensagemCompleta, convertToMp4: false } });
  }

  for (const t of tentativas) {
    try {
      const res = await fetch(`${apiUrl}/chat/getBase64FromMediaMessage/${instance}`, {
        method: "POST",
        headers: { apikey: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(t.corpo),
      });
      const texto = await res.text();
      if (!res.ok) {
        console.error(`[midia] download (${t.nome}) falhou: ${res.status} ${texto.slice(0, 250)}`);
        continue;
      }
      const j = JSON.parse(texto) as { base64?: string; mimetype?: string };
      if (j.base64) {
        console.log(`[midia] download OK pelo formato "${t.nome}" (${j.mimetype ?? "?"})`);
        return { base64: j.base64, mimetype: j.mimetype ?? "application/octet-stream" };
      }
      console.error(`[midia] download (${t.nome}) veio sem base64: ${texto.slice(0, 200)}`);
    } catch (err) {
      console.error(`[midia] erro ao baixar (${t.nome}): ${(err as Error).message}`);
    }
  }
  return null;
}

/** Transcreve áudio com Whisper. Devolve null se não der. */
async function transcrever(base64: string, mimetype: string): Promise<string | null> {
  try {
    const ext = mimetype.includes("mp4") ? "mp4" : mimetype.includes("mpeg") ? "mp3" : "ogg";
    const arquivo = new File([Buffer.from(base64, "base64")], `audio.${ext}`, { type: mimetype });

    const r = await openai.audio.transcriptions.create({
      file: arquivo,
      model: "whisper-1",
      language: "pt",
    });
    const texto = r.text?.trim();
    return texto || null;
  } catch (err) {
    console.error(`[midia] transcrição falhou: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Descreve uma imagem em texto.
 *
 * Cuidado deliberado: paciente manda foto de dente esperando diagnóstico, e a
 * clínica não pode diagnosticar por WhatsApp — é regra do próprio material da
 * de saúde e é risco profissional. Por isso a instrução pede uma descrição
 * neutra do que aparece, sem hipótese clínica, sem nome de doença e sem
 * sugestão de tratamento. Quem decide o que responder é o agente, com as regras
 * dele.
 */
async function descreverImagem(base64: string, mimetype: string, legenda?: string): Promise<string | null> {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Descreva em uma frase curta e neutra o que aparece nesta imagem enviada por um paciente " +
                "a uma clínica odontológica. NÃO faça diagnóstico, NÃO cite nome de doença ou problema " +
                "dentário, NÃO sugira tratamento. Apenas descreva objetivamente o que é a imagem " +
                "(ex.: 'foto dos dentes da frente', 'print de um orçamento', 'documento pessoal').",
            },
            { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
          ],
        },
      ],
      max_tokens: 120,
    });
    const desc = r.choices[0]?.message?.content?.trim();
    if (!desc) return null;
    return legenda ? `${desc} Legenda do paciente: "${legenda}"` : desc;
  } catch (err) {
    console.error(`[midia] leitura de imagem falhou: ${(err as Error).message}`);
    return null;
  }
}

export interface ConteudoRecebido {
  /** Texto que o agente vai ler — digitado, transcrito ou descrito. */
  texto: string;
  /** Como chegou, pra registrar no log e no histórico. */
  origem: "texto" | "audio" | "imagem" | "documento";
}

/**
 * Extrai o conteúdo de uma mensagem da Evolution, seja ela do tipo que for.
 * Devolve null quando não há nada aproveitável (sticker, figurinha, etc.).
 */
export async function extrairConteudo(message: any): Promise<ConteudoRecebido | null> {
  const m = message?.message;
  if (!m) return null;

  const texto: string | undefined = m.conversation ?? m.extendedTextMessage?.text;
  if (texto?.trim()) return { texto: texto.trim(), origem: "texto" };

  const id: string | undefined = message?.key?.id;
  if (!id) return null;

  if (m.audioMessage) {
    const midia = await baixarMidia(id, message);
    const transcricao = midia ? await transcrever(midia.base64, midia.mimetype) : null;
    if (transcricao) return { texto: transcricao, origem: "audio" };

    // Falhou o download ou a transcrição. O que NÃO pode acontecer é o paciente
    // mandar um áudio e não receber nada — foi o que o cliente relatou, e do
    // lado dele parece que a clínica ignorou. Melhor assumir a limitação e pedir
    // por escrito do que ficar mudo.
    console.error(`[midia] áudio de ${message?.key?.remoteJid} não pôde ser processado`);
    return {
      texto:
        "[o paciente enviou um ÁUDIO que você não conseguiu ouvir] Peça desculpas rapidamente, " +
        "diga que não conseguiu ouvir o áudio e peça para ele escrever. Seja breve e natural.",
      origem: "audio",
    };
  }

  if (m.imageMessage) {
    const legenda = m.imageMessage.caption?.trim();
    const midia = await baixarMidia(id, message);
    const desc = midia ? await descreverImagem(midia.base64, midia.mimetype, legenda) : null;
    if (desc) return { texto: `[o paciente enviou uma imagem] ${desc}`, origem: "imagem" };

    // Sem conseguir ver a imagem, a legenda ainda é uma mensagem legítima.
    if (legenda) return { texto: legenda, origem: "imagem" };

    // E sem legenda, mesmo assim se responde: silêncio depois de uma foto parece
    // descaso, e quem manda foto de dente costuma estar pronto pra agendar.
    console.error(`[midia] imagem de ${message?.key?.remoteJid} não pôde ser processada`);
    return {
      texto:
        "[o paciente enviou uma FOTO que você não conseguiu abrir] Agradeça o envio, diga que por " +
        "foto não dá pra avaliar direito e que na avaliação o dentista examina tudo, e ofereça um horário.",
      origem: "imagem",
    };
  }

  if (m.documentMessage || m.documentWithCaptionMessage) {
    // PDF e afins não são lidos: o volume não justifica, e um documento mal
    // interpretado numa clínica é pior do que documento não lido. O agente
    // recebe o aviso e responde pedindo o essencial por texto.
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
    const nome = doc?.fileName ?? "um arquivo";
    return {
      texto:
        `[o paciente enviou um documento: "${nome}", que você NÃO consegue abrir] ` +
        `Peça, com gentileza, que ele resuma em poucas palavras o que precisa, ou diga que pode ` +
        `trazer o documento na avaliação.`,
      origem: "documento",
    };
  }

  return null;
}
