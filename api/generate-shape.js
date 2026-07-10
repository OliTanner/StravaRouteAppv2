import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env (server-only, not VITE_-prefixed)

function promptFor(text) {
  return `You are a GPS-art route generator. Output ONLY a JSON array of [x,y] points (numbers between 0 and 1) tracing the recognizable outline silhouette of: "${text}". Rules: a single continuous closed loop (do NOT repeat the first point at the end), 22 to 42 points, y pointing up, clearly recognizable. No prose, no code fences — just the JSON array.`;
}

function parsePoints(text) {
  const match = text.match(/\[\s*\[[\s\S]*\]\s*\]/);
  if (!match) return null;
  let arr;
  try { arr = JSON.parse(match[0]); } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  const points = arr
    .filter((p) => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]))
    .map((p) => [+p[0], +p[1]]);
  return points.length >= 6 ? points : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    res.status(400).json({ error: 'Missing prompt' });
    return;
  }

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: promptFor(prompt) }],
    });
  } catch (err) {
    res.status(500).json({ error: 'Shape generation failed.' });
    return;
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const points = textBlock ? parsePoints(textBlock.text) : null;
  if (!points) {
    res.status(502).json({ error: 'Could not parse a shape from the response.' });
    return;
  }

  res.status(200).json({ points });
}
