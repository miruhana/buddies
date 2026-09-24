/*
 * Buddies の AI 中継（Cloudflare Workers）
 * スマホのページ → この中継 → Workers AI（Gemma 4）
 * 無料プランのまま使うので、1日の無料枠を使い切ったら止まるだけで請求は発生しません。
 */

const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const PER_IP_PER_DAY = 30;          // 1人（1回線）あたり1日に使える回数
const MAX_BODY = 3 * 1024 * 1024;   // 写真込みで3MBまで
const MAX_TURNS = 14;

// 中継が勝手な用途に使われないよう、アプリ側の指示より先に必ず入れる約束
const GUARD = `あなたは、スマホが苦手な高齢の方を助けるアプリ「Buddies」の案内役です。
スマホ、LINE、サブスク、テレビ、インターネット、詐欺や危ない連絡など、暮らしのデジタルの困りごとの相談に答えます。
答えは、アプリが指定する形（JSONなど）で返します。これはアプリの決まりなので、そのまま従ってください。
利用者の相談が、暮らしのデジタルの困りごとと関係のない作業（長い文章の作成、プログラム作り、宿題など）のときだけ、アプリの形のまま「それはお手伝いできません」と短く伝えます。
暗証番号・パスワード・カード番号は、絶対に聞き出したり書き写したりしません。`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: okOrigin ? 204 : 403, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'GET') return reply(200, { ok: true });
    if (req.method !== 'POST') return reply(405, { code: 'method' });
    if (!okOrigin) return reply(403, { code: 'origin' });

    const len = +(req.headers.get('Content-Length') || 0);
    if (len > MAX_BODY) return reply(413, { code: 'too_large' });

    let body;
    try { body = await req.json(); } catch (e) { return reply(400, { code: 'bad_json' }); }
    const turns = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
    if (!turns.length || turns[turns.length - 1].role !== 'user') return reply(400, { code: 'bad_messages' });
    if (turns.some((t) => !['user', 'assistant'].includes(t.role) || typeof t.content !== 'string' || t.content.length > 60000)) return reply(400, { code: 'bad_messages' });
    const image = typeof body.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(body.image) ? body.image : null;

    // 1回線あたりの1日の回数を数える
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 日本時間の日付
    const key = `n:${day}:${await hash(ip)}`;
    const used = +((await env.RL.get(key)) || 0);
    if (used >= PER_IP_PER_DAY) return reply(429, { code: 'daily_limit' });
    await env.RL.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });

    const messages = [{ role: 'system', content: GUARD }, ...turns.map((t) => ({ role: t.role, content: t.content }))];
    if (image) {
      const last = messages[messages.length - 1];
      last.content = [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: image } }];
    }

    try {
      const out = await env.AI.run(MODEL, {
        messages,
        max_completion_tokens: 1200,
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
        ...(body.json ? { response_format: { type: 'json_object' } } : {}),
      });
      const text = out?.choices?.[0]?.message?.content ?? out?.response ?? '';
      if (!text) return reply(502, { code: 'empty' });
      return reply(200, { text: typeof text === 'string' ? text : JSON.stringify(text) });
    } catch (e) {
      const msg = String(e && e.message || e);
      // 無料枠（1日10,000ニューロン）を使い切ったとき
      if (/4006|neurons|allocation|quota/i.test(msg)) return reply(429, { code: 'quota' });
      return reply(502, { code: 'ai_error' });
    }
  },
};

async function hash(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('');
}
