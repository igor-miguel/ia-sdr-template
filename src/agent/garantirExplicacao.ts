import { supabase } from "../db/supabase.js";
import { ROTEIRO } from "../negocio/negocio.js";

// Garantia determinística de que a explicação sai antes da oferta de horário.
//
// Foi a reclamação nº 1 do primeiro cliente deste sistema e resistiu a três
// tentativas de instrução: regra no prompt, exceção explícita à regra de
// brevidade, reordenação das seções, resumo final, e por fim a instrução dentro
// do retorno da ferramenta. A suíte reprovou todas.
//
// A conclusão vale pra qualquer agente: comportamento que o negócio EXIGE não
// pode depender de o modelo obedecer. Aqui a resposta é inspecionada antes de
// sair — se ela oferece horário sem que a explicação tenha sido dada, a
// explicação é acrescentada. Não há caminho em que o cliente receba a oferta
// sem entender o que vai acontecer.
//
// Para adaptar: edite ROTEIRO.explicacao e ROTEIRO.marcadoresDaExplicacao em
// src/negocio/negocio.ts. Nada aqui precisa mudar.

export const EXPLICACAO = ROTEIRO.explicacao;

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Marcador de que a explicação já saiu — trechos que só aparecem nela.
 *
 * Se você trocar a explicação e esquecer de atualizar os marcadores, a IA
 * repete a explicação inteira a cada mensagem. É o erro mais fácil de cometer
 * neste arquivo.
 */
const MARCADOR = new RegExp(ROTEIRO.marcadoresDaExplicacao.map(escapar).join("|"), "i");

/**
 * A resposta está OFERECENDO um horário — não apenas citando horas.
 *
 * As duas condições juntas importam: "atendemos das 9h às 19h" tem hora e não é
 * oferta nenhuma, e prefixar a explicação ali deixaria a resposta sem sentido.
 */
const HORA_CONCRETA = /\b\d{1,2}\s?(:\d{2}|h\d{0,2})\b/;
const CONVITE = [
  /consigo (um )?(encaixe|hor[áa]rio)/i,
  /posso (agendar|reservar|marcar|confirmar|te colocar)/i,
  /qual (desses )?(hor[áa]rio|fica melhor|prefere)/i,
  /que tal/i,
  /te(nho|mos) (agenda|hor[áa]rio|dispon[íi]vel|livre)/i,
  /agenda dispon[íi]vel/i,
  /hor[áa]rios? dispon[íi]ve/i,
  /quando fica(ria)? (bom|melhor)/i,
  /fica melhor (pra|para) voc[êe]/i,
];

function ofereceHorario(texto: string): boolean {
  return HORA_CONCRETA.test(texto) && CONVITE.some((p) => p.test(texto));
}

async function jaExplicou(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .eq("direction", "out")
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []).some((m) => MARCADOR.test(m.content));
}

/**
 * Corrige no banco a última mensagem gravada.
 *
 * Necessário porque o agente grava a resposta CRUA do modelo antes de passar por
 * aqui. Sem esta correção, três coisas quebram: (1) `jaExplicou` não encontra a
 * explicação que ela mesma inseriu e a insere de novo no turno seguinte —
 * cliente recebe o mesmo texto duas vezes; (2) o histórico enviado ao modelo
 * não contém a explicação, então ele acha que nunca explicou; (3) o painel
 * mostra uma conversa diferente da que o cliente recebeu.
 */
async function corrigirMensagemGravada(conversationId: string, textoFinal: string) {
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "out")
    .order("created_at", { ascending: false })
    .limit(1);

  const ultima = data?.[0];
  if (!ultima) return;
  await supabase.from("messages").update({ content: textoFinal }).eq("id", ultima.id);
}

/**
 * Devolve a resposta pronta para envio, com a explicação na frente quando ela
 * for necessária e estiver faltando.
 *
 * O parágrafo separado vira uma mensagem própria no WhatsApp (ver
 * messaging/humanizado.ts), então o cliente recebe a explicação e a oferta como
 * duas mensagens.
 */
export async function garantirExplicacao(
  conversationId: string,
  resposta: string,
): Promise<string> {
  if (!ofereceHorario(resposta)) return resposta;
  if (MARCADOR.test(resposta)) return resposta;
  if (await jaExplicou(conversationId)) return resposta;

  console.log("[fluxo] resposta oferecia horário sem a explicação — explicação inserida antes");
  const textoFinal = `${EXPLICACAO}\n\n${resposta}`;
  await corrigirMensagemGravada(conversationId, textoFinal);
  return textoFinal;
}
