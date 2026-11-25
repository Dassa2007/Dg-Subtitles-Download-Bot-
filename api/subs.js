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
        const topKeys = Object.keys(json || {});
        logs.push(`Keys:${topKeys.join(",")}`);

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
