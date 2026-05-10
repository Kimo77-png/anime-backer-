/**
 * AnimeStream — Real Aggregator Backend (serves frontend too!)
 * ═══════════════════════════════════════════════════════
 * Setup:
 *   npm install express cors axios cheerio
 *   node server.js
 *
 * This file does:
 *   1. Serves the static frontend from the "public" folder
 *   2. Pulls real anime metadata from Jikan API (MyAnimeList)
 *   3. Auto-builds episode watch URLs for OkAnime and Anime4up
 *   4. Scrapes Animelek episode list on demand
 *   5. WitAnime: manual only (Blogger site – URLs are unpredictable)
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;   // Render provides PORT env variable

app.use(cors());
app.use(express.json());

// ═════════════════════════════════════════════
// SERVE FRONTEND (public folder)
// ═════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: any non-API request goes to index.html
app.get('*', (req, res, next) => {
    // If the request doesn't start with /api, send the SPA
    if (!req.path.startsWith('/api')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
});

// ═══════════════════════════════════════════════════════
// JIKAN API  (free MyAnimeList wrapper — no key needed)
// Rate limit: 3 req/sec, 60 req/min
// ═══════════════════════════════════════════════════════
const JIKAN = 'https://api.jikan.moe/v4';

// Simple in-memory cache so we don't hit rate limits on every page load
const _cache = new Map();
async function cachedGet(url, ttlMs = 60 * 60 * 1000) {   // default 1 h
    if (_cache.has(url)) {
        const { data, ts } = _cache.get(url);
        if (Date.now() - ts < ttlMs) return data;
    }
    const res = await axios.get(url, { timeout: 8000 });
    _cache.set(url, { data: res.data, ts: Date.now() });
    return res.data;
}

// ═══════════════════════════════════════════════════════
// ANIME CONFIG
// ───────────────────────────────────────────────────────
// This is the single place you maintain your library.
//
// Fields:
//  slug        — your frontend slug (keeps HTML working unchanged)
//  malId       — MyAnimeList ID (find it in the MAL URL)
//                e.g. myanimelist.net/anime/16498 → malId: 16498
//  okanime     — OkAnime slug  (from ww3.okanime.xyz/anime/SLUG)
//  anime4up    — Anime4up slug (the part between "انمي-" and "-الحلقة" in their URLs)
//  animelek    — Animelek slug (animelek.top/anime/SLUG) — leave '' if unknown
//  witanime    — Full URL of a specific episode page on witanime.net — leave '' if unknown
//               (WitAnime is Blogger-based so episode URLs can't be auto-built)
// ═══════════════════════════════════════════════════════
const ANIME_CONFIG = [
    {
        slug:     'demon-slayer',
        malId:    47778,
        okanime:  'kimetsu-no-yaiba-katanakaji-no-sato-hen',
        anime4up: 'kimetsu-no-yaiba-katanakaji-no-sato-hen',
        animelek: 'demon-slayer-kimetsu-no-yaiba-swordsmith-village-arc',
        witanime: '',
    },
    {
        slug:     'aot',
        malId:    16498,
        okanime:  'shingeki-no-kyojin',
        anime4up: 'shingeki-no-kyojin',
        animelek: 'attack-on-titan',
        witanime: '',
    },
    {
        slug:     'frieren',
        malId:    52991,
        okanime:  'sousou-no-frieren',
        anime4up: 'sousou-no-frieren',
        animelek: 'frieren-beyond-journeys-end',
        witanime: '',
    },
    {
        slug:     'jjk',
        malId:    40748,
        okanime:  'jujutsu-kaisen',
        anime4up: 'jujutsu-kaisen',
        animelek: 'jujutsu-kaisen',
        witanime: '',
    },
    {
        slug:     'one-piece',
        malId:    21,
        okanime:  'one-piece',
        anime4up: 'ون-بيس-one-piece',
        animelek: 'one-piece',
        witanime: '',
    },
    {
        slug:     'solo-leveling',
        malId:    52299,
        okanime:  'ore-dake-level-up-na-ken',
        anime4up: 'ore-dake-level-up-na-ken',
        animelek: 'solo-leveling',
        witanime: '',
    },
    {
        slug:     'spyxfamily',
        malId:    50265,
        okanime:  'spy-x-family',
        anime4up: 'spy-x-family',
        animelek: 'spy-x-family',
        witanime: '',
    },
    {
        slug:     'chainsaw-man',
        malId:    44511,
        okanime:  'chainsaw-man',
        anime4up: 'chainsaw-man',
        animelek: 'chainsaw-man',
        witanime: '',
    },
];

// ═══════════════════════════════════════════════════════
// URL BUILDERS
// ═══════════════════════════════════════════════════════

/**
 * OkAnime — 100% predictable pattern confirmed from source code
 * https://ww3.okanime.xyz/episode/{okanime-slug}-episode-{num}
 */
function okanimeEpUrl(cfg, epNum) {
    return `https://ww3.okanime.xyz/episode/${cfg.okanime}-episode-${epNum}`;
}

/**
 * Anime4up — pattern confirmed from source code
 * https://w1.anime4up.rest/episode/انمي-{slug}-الحلقة-{num}-مترجمة/
 */
function anime4upEpUrl(cfg, epNum) {
    const raw     = `انمي-${cfg.anime4up}-الحلقة-${epNum}-مترجمة`;
    const encoded = encodeURIComponent(raw);
    return `https://w1.anime4up.rest/episode/${encoded}/`;
}

/**
 * Animelek — WordPress site at animelek.top
 * Scrapes the anime page to get real episode links.
 * Falls back to a search URL if scraping fails.
 */
async function anilelekEpUrls(cfg) {
    const animeUrl = `https://animelek.top/anime/${cfg.animelek}/`;
    try {
        const res = await axios.get(animeUrl, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $    = cheerio.load(res.data);
        const urls = [];
        $('ul.all-episodes-list a, .episodes-list a, .episode-list a, .eps-list a').each((_, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('animelek')) urls.push(href);
        });
        return urls;
    } catch {
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// JIKAN HELPERS
// ═══════════════════════════════════════════════════════

async function fetchAnimeFromJikan(malId) {
    const data = await cachedGet(`${JIKAN}/anime/${malId}`);
    const a    = data.data;
    return {
        title:  a.title_english || a.title,
        type:   a.type   || 'TV',
        eps:    a.episodes || 0,
        score:  a.score   || 0,
        genres: (a.genres || []).map(g => g.name),
        desc:   a.synopsis || '',
        poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
        aired:  a.aired?.from ? a.aired.from.slice(0, 10) : '',
        status: a.status || '',
    };
}

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════

/**
 * GET /api/anime
 * Returns the full library enriched with Jikan metadata.
 */
app.get('/api/anime', async (req, res) => {
    try {
        const results = await Promise.all(
            ANIME_CONFIG.map(async (cfg) => {
                try {
                    const meta = await fetchAnimeFromJikan(cfg.malId);
                    return { slug: cfg.slug, ...meta };
                } catch (err) {
                    console.warn(`Jikan failed for ${cfg.slug}:`, err.message);
                    return {
                        slug: cfg.slug, title: cfg.slug,
                        eps: 0, score: 0, genres: [], desc: '', poster: '',
                    };
                }
            })
        );
        res.json(results);
    } catch (err) {
        console.error('/api/anime error:', err.message);
        res.status(500).json({ error: 'Failed to load anime list' });
    }
});

/**
 * GET /api/anime/:slug
 * Returns metadata + episode list for one anime.
 */
app.get('/api/anime/:slug', async (req, res) => {
    const cfg = ANIME_CONFIG.find(a => a.slug === req.params.slug);
    if (!cfg) return res.status(404).json({ error: 'Anime not found' });

    try {
        const meta   = await fetchAnimeFromJikan(cfg.malId);
        const epData = await cachedGet(`${JIKAN}/anime/${cfg.malId}/episodes`);
        const episodes = (epData.data || []).map(ep => ({
            num:    ep.mal_id,
            title:  ep.title_romanji || ep.title || `Episode ${ep.mal_id}`,
            date:   ep.aired ? ep.aired.slice(0, 10) : '',
            rating: ep.score || 0,
            votes:  0,
        }));

        res.json({ slug: cfg.slug, ...meta, episodes });
    } catch (err) {
        console.error(`/api/anime/${req.params.slug} error:`, err.message);
        res.status(500).json({ error: 'Failed to load anime detail' });
    }
});

/**
 * GET /api/anime/:slug/episode/:epNum
 * Returns the server list for a specific episode.
 */
app.get('/api/anime/:slug/episode/:epNum', async (req, res) => {
    const cfg   = ANIME_CONFIG.find(a => a.slug === req.params.slug);
    const epNum = parseInt(req.params.epNum, 10);

    if (!cfg || isNaN(epNum)) return res.status(404).json({ error: 'Not found' });

    const servers = [];

    // ── OkAnime ─────────────────────────────────────────────────
    if (cfg.okanime) {
        servers.push({
            name:      'OkAnime',
            tag:       '(للمشاهدة)',
            url:       okanimeEpUrl(cfg, epNum),
            qualities: ['FHD 1080p', 'HD 720p', 'SD 480p'],
            status:    'online',
        });
    }

    // ── Anime4up ─────────────────────────────────────────────────
    if (cfg.anime4up) {
        servers.push({
            name:      'Anime4up',
            tag:       '',
            url:       anime4upEpUrl(cfg, epNum),
            qualities: ['FHD 1080p', 'HD 720p', 'SD 480p'],
            status:    'online',
        });
    }

    // ── Animelek ─────────────────────────────────────────────────
    if (cfg.animelek) {
        const lekUrls = await anilelekEpUrls(cfg);
        const epUrl   = lekUrls.find(u => {
            const decoded = decodeURIComponent(u);
            return (
                decoded.includes(`-${epNum}-`) ||
                decoded.includes(`/${epNum}/`) ||
                decoded.endsWith(`-${epNum}`)  ||
                decoded.endsWith(`-${epNum}/`)
            );
        });
        servers.push({
            name:      'Animelek',
            tag:       '',
            url:       epUrl || `https://animelek.top/?s=${encodeURIComponent(cfg.animelek + ' ' + epNum)}`,
            qualities: ['HD 720p', 'SD 480p'],
            status:    epUrl ? 'online' : 'checking',
        });
    }

    // ── WitAnime ─────────────────────────────────────────────────
    // Blogger-based — URLs cannot be auto-generated.
    // Add the episode URL manually in ANIME_CONFIG.witanime if needed.
    if (cfg.witanime) {
        servers.push({
            name:      'WitAnime',
            tag:       '',
            url:       cfg.witanime,
            qualities: ['HD 720p'],
            status:    'online',
        });
    }

    res.json(servers);
});

/**
 * GET /api/search?q=...
 * Live search against MyAnimeList via Jikan.
 */
app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);
    try {
        const data = await cachedGet(
            `${JIKAN}/anime?q=${encodeURIComponent(q)}&limit=12`,
            5 * 60 * 1000   // 5-min cache for search results
        );
        const results = (data.data || []).map(a => ({
            malId:  a.mal_id,
            title:  a.title_english || a.title,
            type:   a.type   || 'TV',
            eps:    a.episodes || 0,
            score:  a.score   || 0,
            genres: (a.genres || []).map(g => g.name),
            desc:   a.synopsis || '',
            poster: a.images?.jpg?.image_url || '',
        }));
        res.json(results);
    } catch (err) {
        console.error('/api/search error:', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log('');
    console.log('✅  AnimeStream API + Web UI is running');
    console.log(`    http://localhost:${PORT}`);
    console.log('');
    console.log('    Endpoints:');
    console.log(`      GET /api/anime                           — full library (Jikan)`);
    console.log(`      GET /api/anime/:slug                     — detail + episode list`);
    console.log(`      GET /api/anime/:slug/episode/:num        — real server URLs`);
    console.log(`      GET /api/search?q=...                    — live MAL search`);
    console.log('');
    console.log('    Sources:');
    console.log('      ✅  OkAnime    — auto-generated URLs');
    console.log('      ✅  Anime4up   — auto-generated URLs');
    console.log('      ⚙️   Animelek   — scraped on-demand from animelek.top');
    console.log('      ⚠️   WitAnime  — manual (Blogger site, add URL per anime in config)');
    console.log('');
});

