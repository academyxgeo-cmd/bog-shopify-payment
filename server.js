import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

const BOG_AUTH_URL =
  "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token";

const BOG_CREATE_ORDER_URL =
  "https://api.bog.ge/payments/v1/ecommerce/orders";

function requiredEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return process.env[name];
}

async function getBogToken() {
  const clientId = requiredEnv("BOG_CLIENT_ID");
  const clientSecret = requiredEnv("BOG_CLIENT_SECRET");

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(BOG_AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials"
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`BOG auth failed: ${text}`);
  }

  return JSON.parse(text);
}

async function createBogOrder({ amount }) {
  const tokenData = await getBogToken();
  const token = tokenData.access_token;

  const appUrl = requiredEnv("APP_URL");

  const payload = {
    callback_url: `${appUrl}/api/bog/callback`,
    external_order_id: `test-${Date.now()}`.slice(0, 25),
    purchase_units: {
      currency: "GEL",
      total_amount: Number(amount),
      basket: [
        {
          product_id: "test-product",
          description: "BOG Shopify test payment",
          quantity: 1,
          unit_price: Number(amount)
        }
      ]
    },
    redirect_urls: {
      success: `${appUrl}/payment-success`,
      fail: `${appUrl}/payment-failed`
    },
    ttl: 30
  };

  const response = await fetch(BOG_CREATE_ORDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "ka",
      Theme: "light",
      "Idempotency-Key": crypto.randomUUID()
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`BOG create order failed: ${text}`);
  }

  return JSON.parse(text);
}

app.get("/", (req, res) => {
  res.send(`
    <h1>BOG Shopify Payment Server</h1>
    <p>Server is running.</p>
    <p><a href="/test-bog-auth">Test BOG Auth</a></p>
    <p><a href="/test-payment">Create 1 GEL Test Payment</a></p>
  `);
});

app.get("/test-bog-auth", async (req, res) => {
  try {
    const tokenData = await getBogToken();

    res.json({
      ok: true,
      message: "BOG auth OK",
      token_type: tokenData.token_type,
      expires_in: tokenData.expires_in,
      access_token_preview: tokenData.access_token
        ? `${tokenData.access_token.slice(0, 15)}...`
        : null
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/test-payment", async (req, res) => {
  try {
    const bogOrder = await createBogOrder({ amount: 1 });

    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/bog/callback", express.json(), (req, res) => {
  console.log("BOG CALLBACK:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.get("/payment-success", (req, res) => {
  res.send(`
    <h1>გადახდა წარმატებულია ✅</h1>
    <p>ტესტ payment success page.</p>
  `);
});

app.get("/payment-failed", (req, res) => {
  res.send(`
    <h1>გადახდა ვერ შესრულდა</h1>
    <p>ტესტ payment failed page.</p>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
