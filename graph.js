/**
 * Cloudflare Pages Function: /graph
 * Serveert graph.html met de Supabase anon key geïnjecteerd via env var.
 * Key staat NIET meer in de HTML broncode.
 *
 * Setup:
 * 1. Voeg toe in Cloudflare dashboard → brain-dashboard → Settings → Variables and Secrets:
 *    SUPABASE_ANON_KEY = <jouw anon key>
 * 2. Push dit bestand naar functions/graph.js in de repo.
 */
export async function onRequest(context) {
  // Fetch de statische graph.html
  const url = new URL(context.request.url);
  url.pathname = '/graph.html';
  const response = await context.env.ASSETS.fetch(url.toString());
  let html = await response.text();

  // Injecteer de key als eerste script-tag
  const key = context.env.SUPABASE_ANON_KEY || '';
  html = html.replace(
    '<script>',
    `<script>window.SB_KEY="${key}";</script>\n<script>`
  );

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}
