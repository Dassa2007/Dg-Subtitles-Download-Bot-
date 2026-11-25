const BOT_TOKEN = process.env.BOT_TOKEN;
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || "";

// User search results තාවකාලිකව මතක තබා ගැනීමට (serverless memory cache)
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
  if (caption) {
    formData.append("caption", caption);
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
  return res.json();
}

// SubDL API / search helper
async function searchSubDL(query) {
  const results = [];
  try {
    if (SUBDL_API_KEY) {
      const url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(SUBDL_API_KEY)}&query=${encodeURIComponent(query)}&subs_per_page=10`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.subtitles)) {
          data.subtitles.slice(0, 8).forEach((item, idx) => {
            const dlPath = item.url || item.download_link || "";
            const fullDl = dlPath.startsWith("http")
              ? dlPath
              : dlPath
              ? `https://dl.subdl.com${dlPath.startsWith("/") ? "" : "/"}${dlPath}`
              : "";

            if (fullDl) {
              results.push({
                id: `subdl_${idx}`,
                source: "SubDL",
                title: `${item.release_name || item.name || query} (${item.lang || "Sub"})`,
                downloadUrl: fullDl,
                suggestedName: `${(item.release_name || query).replace(/[^\w.-]+/g, "_")}.zip`
              });
            }
          });
        }
      }
    }
  } catch (e) {
    console.error("SubDL search error:", e.message);
  }
  return results;
}

// SubSource search helper (basic HTML/endpoint fetch)
async function searchSubSource(query) {
  const results = [];
  try {
    const res = await fetch(`https://subsource.net/search?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Mobile; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36"
      }
    });
    if (res.ok) {
      const html = await res.text();
      // සරල link extraction (site structure අනුව පසුව තවත් adjust කළ හැක)
      const linkRegex = /href="(\/subtitles\/[^"]+)"[^>]*>([^<]+)</gi;
      let match;
      let count = 0;
      while ((match = linkRegex.exec(html)) !== null && count < 6) {
        const pageUrl = `https://subsource.net${match[1]}`;
        const label = match[2].trim();
        if (label) {
          results.push({
            id: `subsrc_${count}`,
            source: "SubSource",
            title: label,
            pageUrl,
            suggestedName: `${label.replace(/[^\w.-]+/g, "_")}.zip`
          });
          count++;
        }
      }
    }
  } catch (e) {
    console.error("SubSource search error:", e.message);
  }
  return results;
}

async function resolveDownload(item) {
  if (item.downloadUrl) {
    return { url: item.downloadUrl, filename: item.suggestedName };
  }

  // SubSource subtitle page එකෙන් direct download link එකක් සෙවීමට උත්සාහ කිරීම
  if (item.pageUrl) {
    const res = await fetch(item.pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Mobile; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36"
      }
    });
    if (res.ok) {
      const html = await res.text();
      const dlMatch = html.match(/href="(https?:\/\/[^"]*(?:\.zip|\.srt|\.ass|download)[^"]*)"/i);
      if (dlMatch && dlMatch[1]) {
        const foundUrl = dlMatch[1];
        let ext = ".zip";
        if (/\.srt/i.test(foundUrl)) ext = ".srt";
        else if (/\.ass/i.test(foundUrl)) ext = ".ass";
        const base = item.suggestedName.replace(/\.(zip|srt|ass)$/i, "");
        return { url: foundUrl, filename: `${base}${ext}` };
      }
    }
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("DG-DEV Subtitle Bot is running!");
  }

  if (!BOT_TOKEN) {
    return res.status(500).send("BOT_TOKEN missing");
  }

  const update = req.body || {};

  try {
    // 1. Button click handle කිරීම
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data || "";

      await tgApi("answerCallbackQuery", { callback_query_id: cq.id });

      if (data.startsWith("pick:")) {
        const itemId = data.replace("pick:", "");
        const userList = searchCache.get(chatId) || [];
        const chosen = userList.find((x) => x.id === itemId);

        if (!chosen) {
          await sendMessage(chatId, "⚠️ Search results expired. කරුණාකර නැවත Anime හෝ Movie නම එවන්න.");
          return res.status(200).json({ ok: true });
        }

        await sendMessage(chatId, `⏳ *${chosen.title}* සඳහා Subtitle file එක සකස් කරමින් පවතී...`);

        const resolved = await resolveDownload(chosen);
        if (!resolved || !resolved.url) {
          await sendMessage(
            chatId,
            `❌ මෙම item එක සඳහා direct file link එක සොයාගත නොහැකි විය (Site protection හෝ structure වෙනසක් විය හැක).\n🔗 Page: ${chosen.pageUrl || "N/A"}`
          );
          return res.status(200).json({ ok: true });
        }

        const fileResp = await fetch(resolved.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Mobile; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36"
          }
        });

        if (!fileResp.ok) {
          await sendMessage(chatId, `❌ File download failed (HTTP ${fileResp.status}).`);
          return res.status(200).json({ ok: true });
        }

        const arrBuf = await fileResp.arrayBuffer();
        const buffer = Buffer.from(arrBuf);

        // Filename extension නිවැරදි කිරීම (.srt / .ass / .zip)
        let finalName = resolved.filename;
        const disp = fileResp.headers.get("content-disposition") || "";
        const nameMatch = disp.match(/filename="?([^";]+)"?/i);
        if (nameMatch && nameMatch[1]) {
          finalName = nameMatch[1].trim();
        } else if (!/\.(srt|ass|zip)$/i.test(finalName)) {
          const ct = fileResp.headers.get("content-type") || "";
          if (ct.includes("zip")) finalName += ".zip";
          else finalName += ".srt";
        }

        await sendDocumentBuffer(
          chatId,
          buffer,
          finalName,
          `🎬 ${chosen.title}\n📦 Source: ${chosen.source}`
        );
      }

      return res.status(200).json({ ok: true });
    }

    // 2. Text / Command messages handle කිරීම
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        await sendMessage(
          chatId,
          "👋 *DG-DEV Subtitle Downloader Bot*\n\n" +
            "🎬 Anime හෝ Movie එකක නම Type කර එවන්න.\n" +
            "🔍 *SubDL* සහ *SubSource* වලින් results පෙන්වා, ඔබ තෝරන `.srt` / `.ass` / `.zip` ෆයිල් එක file එකක් විදිහට එවනු ලැබේ."
        );
        return res.status(200).json({ ok: true });
      }

      await sendMessage(chatId, `🔎 *"${text}"* සඳහා Subtitles සොයමින් පවතී...`);

      const [subdlList, subsourceList] = await Promise.all([
        searchSubDL(text),
        searchSubSource(text)
      ]);

      const combined = [...subdlList, ...subsourceList].slice(0, 10);

      if (combined.length === 0) {
        await sendMessage(
          chatId,
          `😕 *"${text}"* සඳහා results හමු නොවීය (හෝ site එකෙන් request block කර ඇත).\n` +
            `💡 ඉඟිය: Vercel Environment Variables වල \`SUBDL_API_KEY\` එකත් එකතු කර බලන්න.`
        );
        return res.status(200).json({ ok: true });
      }

      searchCache.set(chatId, combined);

      const inlineKeyboard = combined.map((item) => [
        {
          text: `[${item.source}] ${item.title.slice(0, 55)}`,
          callback_data: `pick:${item.id}`
        }
      ]);

      await sendMessage(chatId, "📄 *පහත Subtitles වලින් අවශ්‍ය එක තෝරන්න:*", {
        reply_markup: {
          inline_keyboard: inlineKeyboard
        }
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Bot handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
