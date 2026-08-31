#!/usr/bin/env node
/**
 * Publica vagas ("Horário disponível") na agenda da clínica.
 *
 * Existe porque a agenda passou a funcionar por slots explícitos: a IA só
 * oferece o que estiver publicado, e sem vaga ela não agenda ninguém. Na rotina
 * normal quem publica é o time da clínica; este script serve para testes e para
 * socorrer quando as vagas acabam.
 *
 * Uso:
 *   node scripts/publicar-vagas.mjs                 # próximos 3 dias úteis, 9h/14h/16h
 *   node scripts/publicar-vagas.mjs 5               # próximos 5 dias úteis
 *   node scripts/publicar-vagas.mjs 3 09:00,15:00   # dias e horários específicos
 *   node scripts/publicar-vagas.mjs --listar        # só mostra o que já existe
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(RAIZ, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const TZ = "America/Sao_Paulo";
const fmt = (d, o) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, ...o }).format(d);
const iso = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("-");

/** Expediente: seg-sex 9h-19h, sáb 9h-17h, domingo fechado. */
const EXPEDIENTE = { 0: null, 1: ["09:00", "19:00"], 2: ["09:00", "19:00"], 3: ["09:00", "19:00"], 4: ["09:00", "19:00"], 5: ["09:00", "19:00"], 6: ["09:00", "17:00"] };

async function token() {
  const key = env.GOOGLE_PRIVATE_KEY.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const agora = Math.floor(Date.now() / 1000);
  const naoAssinado = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: env.GOOGLE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(naoAssinado).sign(key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${naoAssinado}.${sig}` }),
  });
  return (await r.json()).access_token;
}

const CAL = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
const ehVaga = (t) => (t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("disponivel");

async function listar(T) {
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${CAL}/events?timeMin=${new Date().toISOString()}&timeMax=${new Date(Date.now() + 21 * 864e5).toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250`,
    { headers: { authorization: `Bearer ${T}` } },
  );
  const j = await r.json();
  return (j.items ?? []).filter((e) => ehVaga(e.summary) && e.start?.dateTime);
}

const T = await token();

if (process.argv.includes("--listar")) {
  const v = await listar(T);
  console.log(`${v.length} vaga(s) publicada(s):`);
  for (const e of v) console.log(`  ${fmt(new Date(e.start.dateTime), { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`);
  process.exit(0);
}

const dias = Number(process.argv[2] ?? 3);
const horarios = (process.argv[3] ?? "09:00,14:00,16:00").split(",").map((h) => h.trim());

const existentes = new Set((await listar(T)).map((e) => e.start.dateTime.slice(0, 16)));
let criadas = 0, puladas = 0;

for (let d = 1; d <= dias * 2 && criadas < dias * horarios.length; d++) {
  const dia = new Date(Date.now() + d * 864e5);
  const data = iso(dia);
  const janela = EXPEDIENTE[new Date(`${data}T12:00:00-03:00`).getDay()];
  if (!janela) continue; // domingo

  for (const hora of horarios) {
    const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, "0")}:${hora.slice(3)}`;
    // Não publica fora do expediente — a IA ignoraria de qualquer forma.
    if (hora < janela[0] || fim > janela[1]) { puladas++; continue; }
    if (existentes.has(`${data}T${hora}`)) { puladas++; continue; }

    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${CAL}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: "Horário disponível",
        start: { dateTime: `${data}T${hora}:00-03:00`, timeZone: TZ },
        end: { dateTime: `${data}T${fim}:00-03:00`, timeZone: TZ },
      }),
    });
    const j = await r.json();
    if (j.id) { criadas++; console.log(`  ✅ ${fmt(new Date(`${data}T${hora}:00-03:00`), { weekday: "short", day: "2-digit", month: "2-digit" })} às ${hora}`); }
    else console.log(`  ❌ ${data} ${hora}: ${JSON.stringify(j).slice(0, 120)}`);
  }
}

console.log(`\n${criadas} vaga(s) criada(s)${puladas ? `, ${puladas} pulada(s) (já existia ou fora do expediente)` : ""}`);
const total = await listar(T);
console.log(`${total.length} vaga(s) disponíveis agora.`);
