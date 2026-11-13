// Phishing Analyzer Pro checkout - raw Stripe API (no SDK)
export async function onRequestGet(context) {
  const { request, env } = context;
  const plan = new URL(request.url).searchParams.get("plan") || "pro";
  
  const prices = { pro: 2900 }; // $29/mo in cents
  const priceCents = prices[plan] || prices.pro;
  const planName = plan === "pro" ? "Phishing Analyzer Pro" : "Phishing Analyzer Pro";

  try {
    const formData = new URLSearchParams();
    formData.append("mode", "subscription");
    formData.append("success_url", "https://edgeiqlabs.com/phish-analyzer/?upgraded=true");
    formData.append("cancel_url", "https://edgeiqlabs.com/phish-analyzer/");
    formData.append("line_items[0][price_data][currency]", "usd");
    formData.append("line_items[0][price_data][unit_amount]", String(priceCents));
    formData.append("line_items[0][price_data][recurring][interval]", "month");
    formData.append("line_items[0][price_data][product_data][name]", planName);
    formData.append("line_items[0][quantity]", "1");

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { return new Response("Stripe parse error", { status: 500 }); }
    
    if (data.url) {
      return new Response(null, { status: 303, headers: { Location: data.url } });
    }
    return new Response(JSON.stringify(data), { status: 500, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
