import type { MessagingProvider } from "./MessagingProvider.js";

// Provider de dev: só loga no console em vez de mandar WhatsApp de verdade.
export class LocalProvider implements MessagingProvider {
  async sendText(telefone: string, text: string): Promise<void> {
    console.log(`[LocalProvider -> ${telefone}] ${text}`);
  }
}
