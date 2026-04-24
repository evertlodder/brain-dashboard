// brain-worker v7 — improved classification prompt
// v7: context-aware classification for Evert Lodder's projects

const DAILY_DUMP_PARSE_PROMPT = `
Je ontvangt een foto van een handgeschreven dagelijkse dump template met de volgende secties:
- INBOX — losse gedachten / ideeën
- PRIORITEIT — top 3 vandaag  
- FOLLOW-UP / open loops

Extraheer alle handgeschreven notities per sectie. Geef de output als JSON in dit exacte formaat:
{
  "sections": {
    "inbox": ["item 1", "item 2"],
    "prioriteit": ["item 1", "item 2"],
    "followup": ["item 1", "item 2"]
  },
  "datum": "YYYY-MM-DD of null als niet leesbaar"
}

Regels:
- Alleen handgeschreven tekst extraheren, geen gedrukte template-tekst
- Lege regels overslaan
- Als een sectie leeg is, geef een lege array
- Antwoord ALLEEN met de JSON, geen uitleg
`;

const SECTION_TO_CATEGORY = {
  inbox: "idea",
  prioriteit: "projects",
  followup: "projects"
};

const NOTION_DB = {
  projects: "fa54487329f54228a95341923c88f6b8",
  admin:    "9702a3311335416f819c1ea18b40f4e0",
  people:   "6ef3562c69b4499897b0fcab60f863fc",
  idea:     "dbc91327537a4f0e86045746682f6e7f"
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
}

async function downloadTelegramFile(token, fileId) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await res.json();
  const filePath = data.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const buffer = await fileRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function stripJson(text) {
  return text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function getEmbedding(text, openrouterKey) {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openrouterKey}`
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text })
  });
  const data = await res.json();
  if (!data || !data.data || !data.data[0] || !data.data[0].embedding) {
    console.error("Embedding error:", JSON.stringify(data));
    return null;
  }
  return data.data[0].embedding;
}

async function captureToSupabase(env, content, category, confidence, nudgeDate, source, embedding) {
  const sbRes = await fetch(`${env.SUPABASE_URL}/rest/v1/thoughts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Prefer": "return=representation"
    },
    body: JSON.stringify({
      content,
      embedding,
      metadata: { category, confidence, nudge_date: nudgeDate, source }
    })
  });
  if (!sbRes.ok) return null;
  const data = await sbRes.json();
  return data && data.length > 0 ? data[0] : null;
}

async function captureToNotion(env, content, category) {
  const dbId = NOTION_DB[category] || NOTION_DB.idea;
  const propMap = {
    projects: { Name: content, Status: "active" },
    admin:    { Name: content, Status: "todo" },
    people:   { Name: content },
    idea:     { Name: content, Status: "raw", Source: "telegram" }
  };
  await fetch(`https://api.notion.com/v1/pages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28"
    },
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: Object.entries(propMap[category] || propMap.idea).reduce((acc, [k, v]) => {
        if (k === "Name") acc[k] = { title: [{ text: { content: v.substring(0, 80) } }] };
        else acc[k] = { select: { name: v } };
        return acc;
      }, {})
    })
  });
}

async function classifyText(text, anthropicKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 200,
      system: `Je bent een classifier voor het persoonlijke kennissysteem van Evert Lodder.

Classificeer elke notitie in PRECIES één categorie:

PROJECTS — gebruik dit voor:
- Alles over SOLARIS / lifepo4calculator.com / app.js / batteries.js / powerpacks.js
- GitHub commits, Cloudflare Pages deploys, codesessies, technische sessieverslagen
- Greenspark Kenya projecten (Bilashaka, Fontana, Kisima, Florensis, Selecta, zonnepanelen, O&M, solar, Fronius)
- Greenspark NL (LiTime, Redodo, Timeusb, Power Queen, webshop, Jortt, affiliate, batterijen, COSS)
- Brain dashboard, Notion setup, Cloudflare Worker, open-brain MCP
- Verbouwing (badkamer, keuken, trap), chalet (Huib, zus)
- Elk lopend initiatief, deliverable, of taak met projectcontext

PEOPLE — gebruik dit voor:
- Een persoon met naam + rol, bedrijf, of relatie-context
- Follow-up op een specifiek persoon
- Contact- of relatienotities
- Voorbeelden: "Paul Kuria finance Kenya", "Craig Kisima contract", "Lydia Redodo coupon", "Eddy Florensis", "Ariane Yu Leadtime"
- Ook: iemand is bereikbaar, iemand heeft gebeld, iemand heet X

IDEA — gebruik dit voor:
- Hypotheses, suggesties, creatieve gedachten, nieuwe richtingen
- Zinnen met: "zou kunnen", "idee", "wat als", "kans", "markt", "stel dat", "misschien", "blog", "feature"
- Nieuwe productrichtingen, blogideeën, tool-ideeën, businessideeën

ADMIN — gebruik dit ALLEEN voor:
- Credentials, wachtwoorden, logins, API keys, tokens
- Puur agendabeheer, afspraken zonder projectcontext
- Belasting, verzekering, facturen, huishoudelijke taken
- Routines en logistiek zonder duidelijk project

Twijfel je tussen PROJECTS en ADMIN? Kies PROJECTS als er een project of initiatief achter zit.
Twijfel je tussen PEOPLE en ADMIN? Kies PEOPLE als er een naam in staat.

Geef ook confidence: high (>80%), medium (50-80%), low (<50%).
Antwoord ALLEEN als JSON: {"category": "...", "confidence": "..."}`,
      messages: [{ role: "user", content: text }]
    })
  });
  const data = await res.json();
  if (!data?.content?.[0]?.text) throw new Error("classify API error: " + JSON.stringify(data).substring(0, 100));
  return JSON.parse(stripJson(data.content[0].text));
}

async function parsePhotoWithVision(base64Image, anthropicKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
          { type: "text", text: DAILY_DUMP_PARSE_PROMPT }
        ]
      }]
    })
  });
  const data = await res.json();
  if (!data?.content?.[0]?.text) throw new Error("vision API error: " + JSON.stringify(data).substring(0, 100));
  return JSON.parse(stripJson(data.content[0].text));
}

function getToday() {
  const now = new Date();
  const amsterdam = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Amsterdam" }));
  return amsterdam.toISOString().split("T")[0];
}

function getTomorrow() {
  const now = new Date();
  const amsterdam = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Amsterdam" }));
  amsterdam.setDate(amsterdam.getDate() + 1);
  return amsterdam.toISOString().split("T")[0];
}

async function sbFetch(env, table, query = "") {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${query}`;
  const res = await fetch(url, {
    headers: {
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) return [];
  return await res.json();
}

async function sbInsertRelation(env, sourceId, sourceType, targetId, targetType, relationType) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/relations`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: JSON.stringify({
      source_id: sourceId,
      source_type: sourceType,
      target_id: targetId,
      target_type: targetType,
      relation_type: relationType
    })
  });
  return res.ok;
}

async function autoLink(env, thoughtId, category, content) {
  if (!thoughtId || !content || content.length < 5) return 0;

  try {
    const [people, projects] = await Promise.all([
      sbFetch(env, "people", "?select=id,name"),
      sbFetch(env, "projects", "?select=id,name")
    ]);

    if (!people.length && !projects.length) return 0;

    const peopleNames = people.map(p => p.name).join(", ");
    const projectNames = projects.map(p => p.name).join(", ");

    const prompt = `Gegeven deze thought: "${content.substring(0, 500)}"

Beschikbare PEOPLE: ${peopleNames || "(none)"}
Beschikbare PROJECTS: ${projectNames || "(none)"}

Welke entities worden expliciet of duidelijk impliciet genoemd in deze thought?
Geef ALLEEN JSON terug, geen tekst:
{"matches": [{"id": "uuid-of-entity", "type": "people|projects"}]}

Alleen entities met >80% zekerheid. Lege array [] als geen matches.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await res.json();
    if (!data?.content?.[0]?.text) return 0;

    const parsed = JSON.parse(stripJson(data.content[0].text));
    const matches = parsed.matches || [];

    let linked = 0;
    for (const match of matches) {
      const success = await sbInsertRelation(
        env,
        thoughtId,
        "thought",
        match.id,
        match.type === "people" ? "person" : "project",
        "spawned_from"
      );
      if (success) linked++;
    }

    return linked;
  } catch (err) {
    console.error("autoLink error:", err.message);
    return 0;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    let body;
    try { body = await request.json(); } catch { return new Response("OK"); }

    const message = body.message;
    if (!message) return new Response("OK");

    const chatId = message.chat.id;
    const token = env.TELEGRAM_BOT_TOKEN;
    const tomorrow = getTomorrow();

    // ── PHOTO: dagelijkse dump snapshot ──
    if (message.photo) {
      await sendTelegram(token, chatId, "📷 Foto ontvangen — verwerken...");

      try {
        const photo = message.photo[message.photo.length - 1];
        const base64 = await downloadTelegramFile(token, photo.file_id);
        const parsed = await parsePhotoWithVision(base64, env.ANTHROPIC_API_KEY);

        let totalCaptured = 0;
        const summaryLines = ["📋 Dagelijkse Dump verwerkt"];
        if (parsed.datum) summaryLines.push("📅 " + parsed.datum);
        summaryLines.push("");

        const sectionLabels = { inbox: "📥 Inbox", prioriteit: "🎯 Prioriteit", followup: "🔁 Follow-up" };

        for (const [section, items] of Object.entries(parsed.sections)) {
          if (!items || items.length === 0) continue;

          const category = SECTION_TO_CATEGORY[section];
          const sectionLines = [];

          for (const item of items) {
            if (!item.trim()) continue;

            let embedding = null;
            try { embedding = await getEmbedding(item, env.OPENROUTER_API_KEY); } catch {}

            let brainThought = null;
            let notionOk = false;
            try { brainThought = await captureToSupabase(env, item, category, "high", tomorrow, "telegram-photo", embedding); } catch {}
            try { await captureToNotion(env, item, category); notionOk = true; } catch {}

            let linkedCount = 0;
            if (brainThought?.id) {
              linkedCount = await autoLink(env, brainThought.id, category, item);
            }

            const linkIcon = linkedCount > 0 ? ` 🔗${linkedCount}` : "";
            sectionLines.push("  + " + item.substring(0, 40) + " " + (brainThought ? "🧠✓" : "🧠✗") + " " + (notionOk ? "📥✓" : "📥✗") + linkIcon);
            totalCaptured++;
          }

          if (sectionLines.length > 0) {
            summaryLines.push(sectionLabels[section] + ":");
            summaryLines.push(...sectionLines);
            summaryLines.push("");
          }
        }

        summaryLines.push(`✅ ${totalCaptured} captured | nudge ${tomorrow}`);
        await sendTelegram(token, chatId, summaryLines.join("\n"));

      } catch (err) {
        await sendTelegram(token, chatId, `❌ Fout bij verwerken foto: ${err.message}`);
      }

      return new Response("OK");
    }

    // ── TEXT: losse notitie ──
    if (message.text) {
      const text = message.text.trim();
      if (!text) return new Response("OK");

      await sendTelegram(token, chatId, "⏳ Verwerken...");

      let classification = { category: "idea", confidence: "medium" };
      try { classification = await classifyText(text, env.ANTHROPIC_API_KEY); } catch {}

      let embedding;
      try { embedding = await getEmbedding(text, env.OPENROUTER_API_KEY); } catch {}

      let brainThought = null;
      let notionOk = false;
      try { brainThought = await captureToSupabase(env, text, classification.category, classification.confidence, tomorrow, "telegram-text", embedding); } catch {}
      try { await captureToNotion(env, text, classification.category); notionOk = true; } catch {}

      let linkedCount = 0;
      if (brainThought?.id) {
        linkedCount = await autoLink(env, brainThought.id, classification.category, text);
      }

      const emoji = { projects: "🚀", people: "👤", idea: "💡", admin: "📋" };
      const statusLine = `${emoji[classification.category] || "📌"} *${classification.category}* · ${classification.confidence}`;
      const brainLine = `${brainThought ? "🧠 Brain ✓" : "🧠 Brain ✗"}  ${notionOk ? "📥 Notion ✓" : "📥 Notion ✗"}`;
      const linkLine = linkedCount > 0 ? ` · 🔗 ${linkedCount} relatie(s)` : "";
      await sendTelegram(token, chatId, [
        statusLine,
        brainLine + linkLine,
        `🔔 nudge ${tomorrow}`
      ].join("\n"));
    }

    return new Response("OK");
  }
};