const BOT_TOKEN = process.env.BOT_TOKEN;
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || "";

const searchCache = new Map();

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://subsource.net/"
};

function toSlug(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function cleanText(str) {
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

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

async function searchSubDL(query) {
  const results = [];
  try {
    if (!SUBDL_API_KEY) return results;
    const url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(
      SUBDL_API_KEY
    )}&query=${encodeURIComponent(query)}&subs_per_page=8`;
    const res = await fetch(url);
    if (!res.ok) return results;
    const data = await res.json();
    if (Array.isArray(data.subtitles)) {
      data.subtitles.slice(0, 6).forEach((item, idx) => {
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
  } catch (e) {
    console.error("SubDL error:", e.message);
  }
  return results;
}

async function searchSubSourceBySlug(query) {
  const slug = toSlug(query);
  if (!slug) return [];

  const candidateUrls = [
    `https://subsource.net/subtitles/${slug}/season-1`,
    `https://subsource.net/subtitles/${slug}`
  ];

  const found = [];
  const seenUrls = new Set();

  for (const pageUrl of candidateUrls) {
    try {
      const res = await fetch(pageUrl, { headers: HEADERS });
      if (!res.ok) continue;

      const html = await res.text();
      // Subtitles list links match කිරීම (slug path එකට යටින් ඇති links)
      const linkRegex = /href="(\/subtitles\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;

      while ((match = linkRegex.exec(html)) !== null && found.length < 8) {
        const href = match[1];
        const fullUrl = `https://subsource.net${href}`;

        // Season/show root link එකම නොවන, specific subtitle links ගැනීම
        if (
          fullUrl !== pageUrl &&
          !seenUrls.has(fullUrl) &&
          href.split("/").filter(Boolean).length >= 3
        ) {
          seenUrls.add(fullUrl);
          const label = cleanText(match[2]) || href.split("/").pop();
          found.push({
            id: `subsrc_${found.length}`,
            source: "SubSource",
            title: label,
            pageUrl: fullUrl,
            suggestedName: `${toSlug(label) || slug}.zip`
          });
        }
      }

      if (found.length > 0) break;
    } catch (e) {
      console.error("SubSource fetch error:", pageUrl, e.message);
    }
  }

  return found;
}

async function resolveDownload(item) {
  if (item.downloadUrl) {
    return { url: item.downloadUrl, filename: item.suggestedName };
  }

  if (item.pageUrl) {
    const res = await fetch(item.pageUrl, { headers: HEADERS });
    if (!res.ok) return null;

    const html = await res.text();
    const patterns = [
      /href="(https?:\/\/[^"]*(?:\.zip|\.srt|\.ass)[^"]*)"/i,
      /href="(\/[^"]*download[^"]*)"/i,
      /data-download-url="([^"]+)"/i
    ];

    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1]) {
        const rawUrl = m[1];
        const finalUrl = rawUrl.startsWith("http")
          ? rawUrl
          : `https://subsource.net${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;

        let ext = ".zip";
        if (/\.srt/i.test(finalUrl)) ext = ".srt";
        else if (/\.ass/i.test(finalUrl)) ext = ".ass";

        const base = item.suggestedName.replace(/\.(zip|srt|ass)$/i, "");
        return { url: finalUrl, filename: `${base}${ext}` };
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
          await sendMessage(chatId, "⚠️ Search results expired. කරුණාකර නැවත නම එවන්න.");
          return res.status(200).json({ ok: true });
        }

        await sendMessage(chatId, `⏳ *${chosen.title}* සඳහා file එක සකස් කරමින් පවතී...`);

        const resolved = await resolveDownload(chosen);
        if (!resolved || !resolved.url) {
          await sendMessage(
            chatId,
            `❌ Direct file link එක සොයාගත නොහැකි විය.\n🔗 Link: ${chosen.pageUrl || "N/A"}`
          );
          return res.status(200).json({ ok: true });
        }

        const fileResp = await fetch(resolved.url, { headers: HEADERS });
        if (!fileResp.ok) {
          await sendMessage(chatId, `❌ Download failed (HTTP ${fileResp.status}).`);
          return res.status(200).json({ ok: true });
        }

        const arrBuf = await fileResp.arrayBuffer();
        const buffer = Buffer.from(arrBuf);

        let finalName = resolved.filename;
        const disp = fileResp.headers.get("content-disposition") || "";
        const nameMatch = disp.match(/filename="?([^";]+)"?/i);
        if (nameMatch && nameMatch[1]) {
          finalName = nameMatch[1].trim();
        } else if (!/\.(srt|ass|zip)$/i.test(finalName)) {
          const ct = fileResp.headers.get("content-type") || "";
          if (ct.includes("zip")) finalName += ".zip";
          else if (ct.includes("ass")) finalName += ".ass";
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

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        await sendMessage(
          chatId,
          "👋 *DG-DEV Subtitle Downloader Bot*\n\n" +
            "🎬 Anime හෝ Movie නමක් Type කර එවන්න (උදා: `Trinity Seven`, `Naruto`).\n" +
            "📄 Subtitles buttons තෝරා `.srt` / `.ass` / `.zip` file ලබාගන්න."
        );
        return res.status(200).json({ ok: true });
      }

      await sendMessage(chatId, `🔎 *"${text}"* සඳහා Subtitles සොයමින් පවතී...`);

      const [subdlList, subsourceList] = await Promise.all([
        searchSubDL(text),
        searchSubSourceBySlug(text)
      ]);

      const combined = [...subdlList, ...subsourceList].slice(0, 10);

      if (combined.length === 0) {
        await sendMessage(
          chatId,
          `😕 *"${text}"* සඳහා subtitles හමු නොවීය (හෝ site එකෙන් server requests block කර ඇත).`
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
    console.error("Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
