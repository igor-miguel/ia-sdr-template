export interface MessagingProvider {
  sendText(telefone: string, text: string): Promise<void>;
  /**
   * Mostra "digitando..." pro contato por `ms` milissegundos. Opcional: o
   * provider local não tem como fazer isso, e a humanização degrada em silêncio
   * quando o provider não implementa (ver messaging/humanizado.ts).
   */
  sendPresence?(telefone: string, ms: number): Promise<void>;
}
