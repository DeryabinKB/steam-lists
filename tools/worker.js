// Steam Lists — прокладка между приложением (браузер/телефон) и Steam.
// Steam не пускает браузер к своему API напрямую, поэтому запросы идут через этот Worker.
//
// Установка (Cloudflare, бесплатно): Workers & Pages → Create → Worker → Deploy →
// Edit code → вставить этот файл целиком → Deploy.
// Settings → Variables and Secrets → добавить два секрета (тип Secret):
//   STEAM_KEY — ключ Steam API (steamcommunity.com/dev/apikey)
//   ACCESS    — пароль для приложения (любая длинная строка, её же вводишь в ⚙ приложения)
// Без правильного пароля Worker ничего не отдаёт. Ключ Steam только для чтения.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-Access', 'Access-Control-Max-Age': '86400' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'steam-lists' } });
  if (!r.ok) throw new Error(`${r.status} ${new URL(url).hostname}`);
  return r.json();
}
const safe = p => p.catch(() => null);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!env.ACCESS || !env.STEAM_KEY) return json({ error: 'Worker не настроен: нет секретов STEAM_KEY / ACCESS' }, 500);
    if (req.headers.get('X-Access') !== env.ACCESS) return json({ error: 'неверный пароль' }, 403);
    const u = new URL(req.url), q = u.searchParams, key = env.STEAM_KEY;
    const sid = q.get('steamid') || '', app = q.get('appid') || '';
    if ((sid && !/^\d{17}$/.test(sid)) || (app && !/^\d{1,10}$/.test(app))) return json({ error: 'bad id' }, 400);
    const API = 'https://api.steampowered.com';
    try {
      if (u.pathname === '/ping') return json({ ok: true });

      // библиотека: игры, часы, последний запуск
      if (u.pathname === '/owned') {
        const r = await get(`${API}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${sid}&include_appinfo=1&include_played_free_games=1`);
        return json({ games: (r.response?.games || []).map(g => ({ appid: g.appid, name: g.name, hours: Math.round(g.playtime_forever / 6) / 10, last: g.rtime_last_played || 0 })) });
      }

      // одна игра: магазин (описание, жанры), теги SteamSpy, все ачивки с редкостью и статусом
      if (u.pathname === '/game') {
        const played = q.get('played') && sid;
        const [store, spy, schema, glob, mine, ust] = await Promise.all([
          safe(get(`https://store.steampowered.com/api/appdetails?appids=${app}&l=russian&cc=ru`)),
          q.get('tags') ? safe(get(`https://steamspy.com/api.php?request=appdetails&appid=${app}`)) : null,
          safe(get(`${API}/ISteamUserStats/GetSchemaForGame/v2/?key=${key}&appid=${app}&l=russian`)),
          safe(get(`${API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${app}`)),
          played ? safe(get(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${key}&steamid=${sid}&appid=${app}`)) : null,
          played ? safe(get(`${API}/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&steamid=${sid}&appid=${app}`)) : null,
        ]);
        const out = { appid: +app, storeOk: !!store };
        const s = store?.[app];
        if (s?.success) {
          const x = s.data;
          out.name = x.name; out.genres = (x.genres || []).map(g => g.description); out.img = x.header_image || '';
          out.info = { desc: x.short_description || '', dev: x.developers || [], pub: x.publishers || [], release: x.release_date?.date || '',
            mc: x.metacritic?.score ?? null, site: x.website || '', shots: (x.screenshots || []).slice(0, 6).map(v => v.path_thumbnail) };
        } else if (store) out.info = { desc: '', dev: [], pub: [], release: '', mc: null, site: '', shots: [] };
        if (spy?.tags && !Array.isArray(spy.tags)) out.tags = Object.entries(spy.tags).sort((a, b) => b[1] - a[1]).slice(0, 12).map(t => t[0]);
        const pct = {}; for (const a of glob?.achievementpercentages?.achievements || []) pct[a.name] = Math.round(parseFloat(a.percent) * 10) / 10;
        const got = {}; for (const a of mine?.playerstats?.achievements || []) if (a.achieved === 1) got[a.apiname] = Math.max(a.unlocktime || 0, 1);
        out.ach = (schema?.game?.availableGameStats?.achievements || []).map(a => ({
          id: a.name, n: a.displayName, d: a.description || '', i: a.icon, g: a.icongray, h: a.hidden ? 1 : 0, p: pct[a.name] ?? null, t: got[a.name] || 0 }));
        out.playerOk = !!mine;
        // счётчики игры (для прогресса ачивок вида 34/100)
        if (ust?.playerstats?.stats) { out.stats = {}; for (const x of ust.playerstats.stats) out.stats[x.name] = x.value; }
        return json(out);
      }
    } catch (e) { return json({ error: String(e.message || e) }, 502); }
    return json({ error: 'not found' }, 404);
  },
};
