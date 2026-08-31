import { config } from "../config.js";
import type { MessagingProvider } from "./MessagingProvider.js";

// Faz a resposta parecer digitada por uma pessoa, e não cuspida por um bot:
// demora pra responder, mostra "digitando...", e manda em pedaços em vez de um
// blocão só. Pedido do Igor em 2026-08-17.

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A presença do WhatsApp expira sozinha em poucos segundos, então é renovada. */
const FATIA_PRESENCA_MS = 8_000;

/**
 * Acima disso o balão vira parede de texto no celular. Começou em 280 e desceu
 * pra 160 porque na prática ainda saía mensagem grande demais — 160 é mais ou
 * menos o tamanho de duas frases curtas de WhatsApp.
 */
const MAX_CHARS_POR_BALAO = 160;

/**
 * Quebra a resposta em balões, na ordem de preferência: parágrafos, depois
 * frases quando o parágrafo é longo demais. Frase nunca é cortada no meio.
 */
export function dividirEmBaloes(texto: string): string[] {
  const paragrafos = texto
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const baloes: string[] = [];
  for (const p of paragrafos) {
    if (p.length <= MAX_CHARS_POR_BALAO) {
      baloes.push(p);
      continue;
    }
    // Parágrafo longo: agrupa frases inteiras até encher o balão.
    const frases = p.match(/[^.!?]+[.!?]*\s*/g) ?? [p];
    let atual = "";
    for (const f of frases) {
      if (atual && (atual + f).length > MAX_CHARS_POR_BALAO) {
        baloes.push(atual.trim());
        atual = f;
      } else {
        atual += f;
      }
    }
    if (atual.trim()) baloes.push(atual.trim());
  }
  return baloes.length ? baloes : [texto.trim()];
}

/** Espera mostrando "digitando...", renovando a presença enquanto durar. */
async function digitandoPor(
  messaging: MessagingProvider,
  telefone: string,
  ms: number,
): Promise<void> {
  let restante = ms;
  while (restante > 0) {
    const fatia = Math.min(restante, FATIA_PRESENCA_MS);
    await messaging.sendPresence?.(telefone, fatia);
    await dormir(fatia);
    restante -= fatia;
  }
}

/** Aplica a variação aleatória configurada em cima de um tempo base. */
function comVariacao(ms: number): number {
  const { variacao } = config.humanizacao;
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * variacao));
}

/**
 * Quanto tempo essa pessoa levaria pra digitar este balão: um piso (ler e
 * começar a responder) mais um tanto por caractere, limitado por um teto.
 */
export function tempoDeDigitacao(balao: string): number {
  const { msPorChar, pisoMs, tetoMs } = config.humanizacao;
  return comVariacao(Math.min(pisoMs + balao.length * msPorChar, tetoMs));
}

/**
 * Envia a resposta como uma pessoa mandaria: pensa um pouco, digita, manda,
 * respira, digita de novo.
 */
export async function enviarHumanizado(
  messaging: MessagingProvider,
  telefone: string,
  texto: string,
): Promise<void> {
  const baloes = dividirEmBaloes(texto);

  if (config.humanizacao.msPorChar <= 0) {
    for (const b of baloes) await messaging.sendText(telefone, b);
    return;
  }

  const tempos = baloes.map(tempoDeDigitacao);
  const pausa = comVariacao(config.humanizacao.pausaEntreBaloesMs);

  // Comprime tudo proporcionalmente se a resposta inteira passar do teto.
  const total = tempos.reduce((s, t) => s + t, 0) + pausa * (baloes.length - 1);
  const escala = total > config.humanizacao.tetoTotalMs ? config.humanizacao.tetoTotalMs / total : 1;

  for (let i = 0; i < baloes.length; i++) {
    // Respiro entre um balão e o próximo — sem isso eles saem quase colados,
    // o que não parece alguém digitando duas mensagens.
    if (i > 0) await dormir(Math.round(pausa * escala));

    await digitandoPor(messaging, telefone, Math.round(tempos[i] * escala));
    await messaging.sendText(telefone, baloes[i]);
  }
}
