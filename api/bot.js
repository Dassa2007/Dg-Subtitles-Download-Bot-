const BOT_TOKEN = process.env.BOT_TOKEN;
const searchCache = new Map();

async function tgApi(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    ...extra
  });
}

async function sendDocumentBuffer(chatId, buffer, filename, caption = "") {
  const formData = new FormData();
  const blob = new Blob([buffer]);
  formData.append("chat_id", String(chatId));
  formData.append("document", blob, filename);
  if (caption) formData.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("DG-DEV Subtitle Bot is running!");
  }

  if (!BOT_TOKEN) {
    return res.status(500).send("BOT_TOKEN missing");
  }

  const update = req.body || {};
  const host = req.headers["x-forwarded-host"] || req.headers.host || "dg-subtitles-download-bot.vercel.app";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${proto}://${host}`;

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data || "";

      await tgApi("answerCallbackQuery", { callback_query_id: cq.id });

      if (data.startsWith("pick:")) {
        const itemId = data.replace("pick:", "");
        const list = searchCache.get(chatId) || [];
        const chosen = list.find((x) => x.id === itemId);

        if (!chosen) {
          await sendMessage(chatId, "⚠️ Results expire වෙලා. නැවත නමක් එවන්න.");
          return res.status(200).json({ ok: true });
        }

        if (!chosen.downloadUrl) {
          await sendMessage(
            chatId,
            `ℹ️ *${chosen.title}*\n🔗 Link: ${chosen.pageUrl || "Direct download ලබාගත නොහැක."}`
          );
          return res.status(200).json({ ok: true });
        }

        await sendMessage(chatId, `⏳ *${chosen.title}* file එක බාගත කරමින් පවතී...`);
        const r = await fetch(chosen.downloadUrl);
        if (!r.ok) {
          await sendMessage(chatId, `❌ Download failed (HTTP ${r.status}).`);
          return res.status(200).json({ ok: true });
        }

        const buf = Buffer.from(await r.arrayBuffer());
        const safeName = `${chosen.title.replace(/[^\w.-]+/g, "_").slice(0, 40)}.zip`;
        await sendDocumentBuffer(chatId, buf, safeName, `🎬 ${chosen.title}\n📦 ${chosen.source}`);
      }

      return res.status(200).json({ ok: true });
    }

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        await sendMessage(
          chatId,
          "👋 *DG-DEV Subtitle Bot*\n\n🎬 Anime හෝ Movie නමක් එවන්න (උදා: `Naruto`)."
        );
        return res.status(200).json({ ok: true });
      }

      await sendMessage(chatId, `🔎 *"${text}"* සොයමින් පවතී...`);

      const apiRes = await fetch(`${baseUrl}/api/subs?q=${encodeURIComponent(text)}`);
      const apiData = await apiRes.json();

      const items = Array.isArray(apiData.items) ? apiData.items : [];
      if (items.length === 0) {
        const logText = Array.isArray(apiData.logs) && apiData.logs.length
          ? `\n🛠 Logs: \`${apiData.logs.join(" | ")}\``
          : "";
        await sendMessage(chatId, `😕 *"${text}"* සඳහා results හමු නොවීය.${logText}`);
        return res.status(200).json({ ok: true });
      }

      searchCache.set(chatId, items);
      const keyboard = items.map((it) => [
        {
          text: `[${it.source}] ${it.title.slice(0, 55)}`,
          callback_data: `pick:${it.id}`
        }
      ]);

      await sendMessage(chatId, "📄 *පහත Subtitles වලින් එකක් තෝරන්න:*", {
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Bot error:", err);
    if (update.message && update.message.chat && update.message.chat.id && BOT_TOKEN) {
      await sendMessage(update.message.chat.id, `❌ Error: \`${err.message}\``);
    }
    return res.status(200).json({ ok: true });
  }
}
