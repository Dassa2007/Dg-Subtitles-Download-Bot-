const SUBDL_API_KEY = process.env.SUBDL_API_KEY || "";

function toSlug(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export default async function handler(req, res) {
  try {
    const q = String((req.query && req.query.q) || "").trim();
    if (!q) {
      return res.status(400).json({ ok: false, error: "Missing query ?q=" });
    }

    const items = [];
    const logs = [];

    if (SUBDL_API_KEY) {
      try {
        const url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(
          SUBDL_API_KEY
        )}&query=${encodeURIComponent(q)}&subs_per_page=8`;

        const r = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0"
          }
        });
        const txt = await r.text();
        logs.push(`SubDL HTTP ${r.status}`);

        let json = null;
        try {
          json = JSON.parse(txt);
        } catch (_) {
          logs.push(`SubDL non-JSON: ${txt.slice(0, 50)}`);
        }

        if (json && typeof json === "object") {
          logs.push(`Keys:${Object.keys(json).join(",")}`);

          const rawList = Array.isArray(json.subtitles)
            ? json.subtitles
            : Array.isArray(json.results)
            ? json.results
            : Array.isArray(json.data)
            ? json.data
            : [];

          if (rawList.length > 0) {
            logs.push(`ItemKeys:${Object.keys(rawList[0] || {}).slice(0, 6).join("/")}`);
          }

          rawList.slice(0, 6).forEach((sub, i) => {
            const title =
              sub.release_name || sub.name || sub.title || sub.movie_name || `${q} Sub ${i + 1}`;
            const lang = sub.lang || sub.language || "Sub";
            const dlRaw = sub.url || sub.download_link || sub.link || "";
            const downloadUrl = dlRaw
              ? dlRaw.startsWith("http")
                ? dlRaw
                : `https://dl.subdl.com${dlRaw.startsWith("/") ? "" : "/"}${dlRaw}`
              : "";

            items.push({
              id: `subdl_${i}`,
              source: "SubDL",
              title: `${title} (${lang})`,
              downloadUrl,
              pageUrl: ""
            });
          });
        }
      } catch (e) {
        logs.push(`SubDL err: ${e.message}`);
      }
    } else {
      logs.push("No SUBDL_API_KEY");
    }

    try {
      const slug = toSlug(q);
      const subUrl = `https://subsource.net/subtitles/${slug}/season-1`;
      const r = await fetch(subUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        }
      });
      logs.push(`SubSource HTTP ${r.status}`);
    } catch (e) {
      logs.push(`SubSource err: ${e.message}`);
    }

    return res.status(200).json({ ok: items.length > 0, items, logs });
  } catch (err) {
    return res.status(200).json({ ok: false, items: [], logs: [`Handler err: ${err.message}`] });
  }
}
