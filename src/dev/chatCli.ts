import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureLeadConversation } from "../db/leads.js";
import { runAgentTurn } from "../agent/agent.js";
import { LocalProvider } from "../messaging/LocalProvider.js";

// CLI local pra testar o agente sem depender do WhatsApp/Evolution API.
// Uso: npm run chat -- +5561999999999 "Nome do lead"
async function main() {
  const telefone = process.argv[2] ?? "+5561999999999";
  const nome = process.argv[3];

  const lead = await ensureLeadConversation(telefone, nome);
  console.log(`Conversando como ${lead.leadNome} (${lead.leadTelefone}). Ctrl+C pra sair.\n`);

  // O agente precisa de um provider pra avisar a secretária num handoff; aqui
  // basta o local, que só imprime — este CLI não manda WhatsApp de verdade.
  const messaging = new LocalProvider();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  for (;;) {
    const userMessage = await rl.question("você> ");
    if (!userMessage.trim()) continue;
    const reply = await runAgentTurn(
      {
        leadId: lead.leadId,
        leadNome: lead.leadNome,
        leadTelefone: lead.leadTelefone,
        conversationId: lead.conversationId,
      },
      userMessage,
      messaging,
    );
    console.log(`sdr> ${reply}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
