export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
};

export function jsonOk<T>(data: T): Response {
  return Response.json(data, { headers: corsHeaders });
}

export function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

export function optionsResponse(): Response {
  return new Response(null, { headers: corsHeaders });
}

// Retry-After lets a legitimate client back off correctly instead of hammering.
export function jsonRateLimited(retryAfterSec = 60): Response {
  return Response.json(
    { error: "Too many failed attempts. Try again shortly." },
    { status: 429, headers: { ...corsHeaders, "Retry-After": String(retryAfterSec) } }
  );
}
