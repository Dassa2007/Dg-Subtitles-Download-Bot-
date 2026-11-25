const SUBDL_API_KEY = process.env.SUBDL_API_KEY || "";

function toSlug(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export default async function handler(req, res) {
  const q = (req.query.q || "").trim();
  if (!q) {
    return res.status(400).json({ ok: false, error: "Missing query ?q=" });
  }

  const items = [];
  const logs = [];

  // 1. SubDL API check
  if (SUBDL_API_KEY) {
    try {
      const url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(
        SUBDL_API_KEY
      )}&query=${encodeURIComponent(q)}&subs_per_page=8`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      const txt = await r.text();
      logs.push(`SubDL HTTP ${r.status}`);

      if (r.ok) {
        const json = JSON.parse(txt);
        const list = Array.isArray(json.subtitles) ? json.subtitles : [];
        list.slice(0, 6).forEach((sub, i) => {
          items.push({
            id: `subdl_${i}`,
            source: "SubDL",
            title: `${sub.release_name || sub.name || q} (${sub.lang || "Sub"})`,
            downloadUrl: sub.url ? `https://dl.subdl.com${sub.url}` : "",
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

  // 2. SubSource slug page check
  try {
    const slug = toSlug(q);
    const subUrl = `https://subsource.net/subtitles/${slug}/season-1`;
    const r = await fetch(subUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36"
      }
    });
    logs.push(`SubSource HTTP ${r.status}`);
    if (r.ok) {
      const html = await r.text();
      const regex = /href="(\/subtitles\/[^"#?]+)"[^>]*>([^<]+)</gi;
      let m;
      let c = 0;
      while ((m = regex.exec(html)) !== null && c < 5) {
        const label = m[2].trim();
        if (label) {
          items.push({
            id: `subsrc_${c}`,
            source: "SubSource",
            title: label,
            downloadUrl: "",
            pageUrl: `https://subsource.net${m[1]}`
          });
          c++;
        }
      }
    }
  } catch (e) {
    logs.push(`SubSource err: ${e.message}`);
  }

  return res.status(200).json({ ok: items.length > 0, items, logs });
}
