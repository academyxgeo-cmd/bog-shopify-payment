import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOG_AUTH_URL =
  "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token";

const BOG_CREATE_ORDER_URL =
  "https://api.bog.ge/payments/v1/ecommerce/orders";


function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeGeorgianPhone(phone = "") {
  const cleaned = String(phone).replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  if (cleaned.startsWith("995")) {
    return `+${cleaned}`;
  }

  if (cleaned.startsWith("5") && cleaned.length === 9) {
    return `+995${cleaned}`;
  }

  return cleaned;
}

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
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`BOG auth failed: ${text}`);
  }

  return JSON.parse(text);
}

async function getShopifyToken() {
  const shop = requiredEnv("SHOPIFY_SHOP");
  const clientId = requiredEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = requiredEnv("SHOPIFY_CLIENT_SECRET");

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify token failed: ${text}`);
  }

  return JSON.parse(text).access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const shop = requiredEnv("SHOPIFY_SHOP");
  const token = await getShopifyToken();

  const response = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const json = await response.json();

  if (!response.ok || json.errors) {
    throw new Error(`Shopify GraphQL failed: ${JSON.stringify(json)}`);
  }

  return json.data;
}

async function getShopifyOrder(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query GetOrder($id: ID!) {
      node(id: $id) {
        ... on Order {
          id
          name
          displayFinancialStatus
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: gid });

  if (!data.node) {
    throw new Error("Shopify order not found");
  }

  return data.node;
}

async function markShopifyOrderAsPaid(shopifyOrderGid) {
  const mutation = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        userErrors {
          field
          message
        }
        order {
          id
          name
          displayFinancialStatus
        }
      }
    }
  `;

  const data = await shopifyGraphQL(mutation, {
    input: {
      id: shopifyOrderGid,
    },
  });

  const errors = data.orderMarkAsPaid?.userErrors || [];

  if (errors.length) {
    throw new Error(`Shopify mark paid failed: ${JSON.stringify(errors)}`);
  }

  return data.orderMarkAsPaid.order;
}


async function createPendingShopifyOrder({
  variantId,
  quantity,
  firstName,
  lastName,
  phone,
  email,
  city,
  address1,
}) {
  const shop = requiredEnv("SHOPIFY_SHOP");
  const token = await getShopifyToken();

  const cleanQuantity = Math.max(1, Number(quantity || 1));
  const normalizedPhone = normalizeGeorgianPhone(phone);

  const orderPayload = {
    order: {
      line_items: [
        {
          variant_id: Number(variantId),
          quantity: cleanQuantity,
        },
      ],
      financial_status: "pending",
      email: email || undefined,
      phone: normalizedPhone || undefined,
      tags: "BOG Direct Checkout",
      note: "Created from custom BOG direct checkout",
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        phone: normalizedPhone,
        address1,
        city,
        country: "Georgia",
        country_code: "GE",
      },
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        phone: normalizedPhone,
        address1,
        city,
        country: "Georgia",
        country_code: "GE",
      },
      shipping_lines: [
        {
          title: "Delivery",
          price: "0.00",
          code: "delivery",
        },
      ],
      send_receipt: false,
      send_fulfillment_receipt: false,
    },
  };

  const response = await fetch(`https://${shop}/admin/api/2026-04/orders.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify(orderPayload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify order create failed: ${text}`);
  }

  return JSON.parse(text).order;
}

async function createBogOrderForShopifyOrder(orderId, order) {
  const tokenData = await getBogToken();
  const token = tokenData.access_token;
  const appUrl = requiredEnv("APP_URL");

  const outstanding = order.totalOutstandingSet?.shopMoney;
  const currentTotal = order.currentTotalPriceSet?.shopMoney;

  const amount =
    outstanding?.amount && Number(outstanding.amount) > 0
      ? outstanding.amount
      : currentTotal.amount;

  const currency =
    outstanding?.currencyCode || currentTotal.currencyCode || "GEL";

  if (currency !== "GEL") {
    throw new Error(`Unsupported currency: ${currency}. BOG needs GEL.`);
  }

  const payload = {
    callback_url: `${appUrl}/api/bog/callback`,
    external_order_id: `s${orderId}`.slice(0, 25),
    purchase_units: {
      currency: "GEL",
      total_amount: Number(amount),
      basket: [
        {
          product_id: `shopify-${orderId}`,
          description: `Shopify order ${order.name}`,
          quantity: 1,
          unit_price: Number(amount),
        },
      ],
    },
    redirect_urls: {
      success: `${appUrl}/payment-success?order=${encodeURIComponent(order.name)}`,
      fail: `${appUrl}/payment-failed?order=${encodeURIComponent(order.name)}`,
    },
    ttl: 30,
  };

  const response = await fetch(BOG_CREATE_ORDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "ka",
      Theme: "light",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`BOG create order failed: ${text}`);
  }

  return JSON.parse(text);
}

async function createTestBogOrder({ amount }) {
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
          unit_price: Number(amount),
        },
      ],
    },
    redirect_urls: {
      success: `${appUrl}/payment-success`,
      fail: `${appUrl}/payment-failed`,
    },
    ttl: 30,
  };

  const response = await fetch(BOG_CREATE_ORDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "ka",
      Theme: "light",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
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
    <p><a href="/test-shopify-auth">Test Shopify Auth</a></p>
    <p><a href="/test-payment">Create 1 GEL Test Payment</a></p>
    <p>Direct checkout endpoint: <code>/checkout?variant_id=SHOPIFY_VARIANT_ID&quantity=1</code></p>
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
        : null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/test-shopify-auth", async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        shop {
          name
          myshopifyDomain
        }
      }
    `);

    res.json({
      ok: true,
      message: "Shopify auth OK",
      shop: data.shop,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/test-payment", async (req, res) => {
  try {
    const bogOrder = await createTestBogOrder({ amount: 1 });
    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder,
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});


app.get("/checkout", async (req, res) => {
  const variantId = req.query.variant_id;
  const quantity = req.query.quantity || 1;

  if (!variantId) {
    return res.status(400).send("Missing variant_id");
  }

  res.send(`
    <!doctype html>
    <html lang="ka">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>შეკვეთის გაფორმება</title>
        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #f6f6f6;
            color: #111;
            padding: 30px 14px;
          }
          .box {
            max-width: 520px;
            margin: 0 auto;
            background: #fff;
            border-radius: 18px;
            padding: 26px;
            box-shadow: 0 12px 30px rgba(0,0,0,.08);
          }
          h1 {
            margin-top: 0;
            font-size: 24px;
          }
          label {
            display: block;
            margin-top: 14px;
            font-weight: 700;
            font-size: 14px;
          }
          input {
            width: 100%;
            box-sizing: border-box;
            margin-top: 6px;
            padding: 13px 14px;
            border: 1px solid #ddd;
            border-radius: 10px;
            font-size: 16px;
          }
          button {
            width: 100%;
            margin-top: 22px;
            background: #111;
            color: #fff;
            border: 0;
            border-radius: 12px;
            padding: 15px 18px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
          }
          .small {
            color: #666;
            font-size: 13px;
            line-height: 1.45;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>შეკვეთის გაფორმება</h1>
          <p class="small">შეავსეთ მონაცემები და შემდეგ გადახვალთ საქართველოს ბანკის უსაფრთხო გადახდის გვერდზე.</p>

          <form method="POST" action="/checkout">
            <input type="hidden" name="variant_id" value="${escapeHtml(variantId)}" />
            <input type="hidden" name="quantity" value="${escapeHtml(quantity)}" />

            <label>სახელი</label>
            <input name="first_name" required />

            <label>გვარი</label>
            <input name="last_name" required />

            <label>ტელეფონი</label>
            <input name="phone" required placeholder="მაგ: 599123456" />

            <label>ელფოსტა</label>
            <input name="email" type="email" />

            <label>ქალაქი</label>
            <input name="city" required />

            <label>მისამართი</label>
            <input name="address1" required />

            <button type="submit">გადახდა საქართველოს ბანკით</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post("/checkout", async (req, res) => {
  try {
    const {
      variant_id,
      quantity,
      first_name,
      last_name,
      phone,
      email,
      city,
      address1,
    } = req.body;

    if (!variant_id || !first_name || !last_name || !phone || !city || !address1) {
      return res.status(400).send("Missing required checkout fields");
    }

    const createdOrder = await createPendingShopifyOrder({
      variantId: variant_id,
      quantity,
      firstName: first_name,
      lastName: last_name,
      phone,
      email,
      city,
      address1,
    });

    const numericOrderId = createdOrder.id;
    const order = await getShopifyOrder(numericOrderId);

    const bogOrder = await createBogOrderForShopifyOrder(numericOrderId, order);
    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder,
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Custom checkout error:", error);

    return res.status(500).send(`
      <h1>შეკვეთა ვერ შეიქმნა</h1>
      <p>${escapeHtml(error.message)}</p>
    `);
  }
});


app.get("/pay/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;

    if (!/^\d+$/.test(orderId)) {
      return res.status(400).send("Invalid Shopify order ID");
    }

    const order = await getShopifyOrder(orderId);

    if (order.displayFinancialStatus === "PAID") {
      return res.redirect(
        `/payment-success?order=${encodeURIComponent(order.name)}`
      );
    }

    const bogOrder = await createBogOrderForShopifyOrder(orderId, order);
    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder,
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Pay link error:", error);

    return res.status(500).send(`
      <h1>გადახდის ბმული ვერ შეიქმნა</h1>
      <p>${error.message}</p>
    `);
  }
});
app.get("/pay-order/:orderName", async (req, res) => {
  try {
    const rawOrderName = decodeURIComponent(req.params.orderName);
    const orderName = rawOrderName.startsWith("#")
      ? rawOrderName
      : `#${rawOrderName}`;

    const query = `
      query FindOrder($query: String!) {
        orders(first: 1, query: $query) {
          nodes {
            id
            name
            displayFinancialStatus
            totalOutstandingSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, {
      query: `name:${orderName}`,
    });

    const order = data.orders.nodes[0];

    if (!order) {
      throw new Error(`Shopify order not found by name: ${orderName}`);
    }

    if (order.displayFinancialStatus === "PAID") {
      return res.redirect(
        `/payment-success?order=${encodeURIComponent(order.name)}`
      );
    }

    const numericId = order.id.split("/").pop();

    const bogOrder = await createBogOrderForShopifyOrder(numericId, order);
    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder,
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Pay by order name error:", error);

    return res.status(500).send(`
      <h1>გადახდის ბმული ვერ შეიქმნა</h1>
      <p>${error.message}</p>
    `);
  }
});
app.post("/api/bog/callback", async (req, res) => {
  try {
    console.log("BOG CALLBACK:", JSON.stringify(req.body, null, 2));

    const body = req.body.body || req.body;

    const status = body.order_status?.key || body.status;
    const externalOrderId = body.external_order_id;

    let shopifyOrderGid = null;

    if (externalOrderId?.startsWith("s")) {
      const numericOrderId = externalOrderId.slice(1);
      shopifyOrderGid = `gid://shopify/Order/${numericOrderId}`;
    }

    if (status === "completed" && shopifyOrderGid) {
      const paidOrder = await markShopifyOrderAsPaid(shopifyOrderGid);
      console.log("Shopify order marked as paid:", paidOrder);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("BOG callback error:", error);
    return res.sendStatus(500);
  }
});

app.get("/payment-success", (req, res) => {
  const order = req.query.order || "";

  res.send(`
    <h1>გადახდა წარმატებულია ✅</h1>
    <p>${order ? `შეკვეთა: <strong>${order}</strong>` : ""}</p>
    <p>გადახდის დადასტურების შემდეგ Shopify order ავტომატურად განახლდება.</p>
    <p><a href="https://mypiano.ge">mypiano.ge-ზე დაბრუნება</a></p>
  `);
});

app.get("/payment-failed", (req, res) => {
  const order = req.query.order || "";

  res.send(`
    <h1>გადახდა ვერ შესრულდა</h1>
    <p>${order ? `შეკვეთა: <strong>${order}</strong>` : ""}</p>
    <p>სცადეთ თავიდან ან დაგვიკავშირდით.</p>
    <p><a href="https://mypiano.ge">mypiano.ge-ზე დაბრუნება</a></p>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
