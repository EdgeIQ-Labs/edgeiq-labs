// Phishing Analyzer Pro checkout - raw Stripe API (no SDK)
export async function onRequestGet(context) {
  const { request, env } = context;
  const plan = new URL(request.url).searchParams.get("plan") || "pro";
  
  const PRICE_ID = "price_1UbfMsRC1NZ20yDT5HE1QfxL"; // Phishing Analyzer Pro $29/mo

  try {
    const formData = new URLSearchParams();
    formData.append("mode", "subscription");
    formData.append("success_url", "https://edgeiqlabs.com/phish-analyzer/?upgraded=true");
    formData.append("cancel_url", "https://edgeiqlabs.com/phish-analyzer/");
    formData.append("line_items[0][price]", PRICE_ID);
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
