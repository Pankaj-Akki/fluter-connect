import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

function riderTag(customerId: string) {
  return `flutter_customer_${customerId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

async function handleGetOrders(request: Request) {
  console.log("=== APP PROXY ORDERS REQUEST RECEIVED ===", request.method, request.url);
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) {
    return Response.json(
      { success: false, message: "App is not installed or Admin session unavailable." },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  let customerId = (url.searchParams.get("customer_id") || "").trim();
  let email = (url.searchParams.get("email") || "").trim();

  if (request.method === "POST" || request.method === "PUT") {
    try {
      const body = await request.json();
      if (!customerId) customerId = String(body.customer_id || "").trim();
      if (!email) email = String(body.email || "").trim();
    } catch (e) {
      // Ignored
    }
  }

  console.log(`=== ORDERS PROXY SEARCH PARAMS: customerId="${customerId}", email="${email}" ===`);

  if (!customerId && !email) {
    return Response.json(
      { success: false, message: "customer_id or email parameter is required." },
      { status: 400 }
    );
  }

  const rawId = customerId;
  const cleanNum = rawId.replace(/^R/i, "");
  
  const tag1 = riderTag(rawId);          // e.g. flutter_customer_521 or flutter_customer_R521
  const tag2 = riderTag(`R${cleanNum}`); // e.g. flutter_customer_R521
  const tag3 = riderTag(cleanNum);       // e.g. flutter_customer_521

  // Build robust search terms for Shopify GraphQL
  const searchTerms = [
    tag1 ? `tag:${tag1}` : '',
    tag2 ? `tag:${tag2}` : '',
    tag3 ? `tag:${tag3}` : '',
    rawId ? `tag:${rawId}` : '',
    cleanNum ? `tag:R${cleanNum}` : '',
    cleanNum ? `tag:${cleanNum}` : '',
    email ? `email:${email}` : '',
  ].filter(Boolean);

  const searchQuery = searchTerms.join(" OR ");
  console.log("=== EXECUTING SHOPIFY GRAPHQL QUERY ===", searchQuery);

  const response = await admin.graphql(
    `#graphql
    query FindCustomerOrders($query: String!) {
      customers(first: 10, query: $query) {
        nodes {
          id
          firstName
          lastName
          email
          tags
          orders(first: 25, sortKey: CREATED_AT, reverse: true) {
            nodes {
              id
              name
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              displayFulfillmentStatus
              displayFinancialStatus
              lineItems(first: 20) {
                nodes {
                  title
                  quantity
                  variant {
                    id
                    price
                    image {
                      url
                    }
                  }
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
      allRecentOrders: orders(first: 30, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          displayFulfillmentStatus
          displayFinancialStatus
          customer {
            id
            email
            tags
          }
          lineItems(first: 20) {
            nodes {
              title
              quantity
              variant {
                id
                price
                image {
                  url
                }
              }
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { query: searchQuery } }
  );

  const json = await response.json();
  console.log("=== GRAPHQL RESPONSE DATA ===", JSON.stringify(json));

  const customerNodes = json.data?.customers?.nodes || [];
  const allRecentOrders = json.data?.allRecentOrders?.nodes || [];

  const map = new Map<string, any>();

  // 1. Add orders from matching customers
  for (const cust of customerNodes) {
    const custOrders = cust.orders?.nodes || [];
    for (const o of custOrders) {
      if (!map.has(o.id)) {
        map.set(o.id, o);
      }
    }
  }

  // 2. Add orders directly matching customer email or tags
  for (const o of allRecentOrders) {
    const cust = o.customer;
    if (cust) {
      const matchEmail = email && cust.email && cust.email.toLowerCase() === email.toLowerCase();
      const custTags = cust.tags || [];
      const matchTag = custTags.some((t: string) => 
        (rawId && t.includes(rawId)) || 
        (cleanNum && t.includes(`R${cleanNum}`)) || 
        (cleanNum && t.includes(cleanNum))
      );

      if ((matchEmail || matchTag) && !map.has(o.id)) {
        map.set(o.id, o);
      }
    }
  }

  const orders = Array.from(map.values()).map((o: any) => ({
    id: o.id,
    name: o.name,
    created_at: o.createdAt,
    total_price: o.totalPriceSet?.shopMoney ? `${o.totalPriceSet.shopMoney.currencyCode === 'INR' ? '₹' : o.totalPriceSet.shopMoney.currencyCode + ' '}${parseFloat(o.totalPriceSet.shopMoney.amount).toFixed(2)}` : '',
    total_amount: o.totalPriceSet?.shopMoney?.amount || '0.00',
    fulfillment_status: (o.displayFulfillmentStatus || 'Processing').toUpperCase(),
    financial_status: o.displayFinancialStatus || '',
    line_items: (o.lineItems?.nodes || []).map((li: any) => ({
      title: li.title,
      quantity: li.quantity,
      price: li.originalUnitPriceSet?.shopMoney ? `${li.originalUnitPriceSet.shopMoney.currencyCode === 'INR' ? '₹' : li.originalUnitPriceSet.shopMoney.currencyCode + ' '}${parseFloat(li.originalUnitPriceSet.shopMoney.amount).toFixed(2)}` : '',
      variant_id: li.variant?.id ? li.variant.id.split('/').pop() : null,
      image_url: li.variant?.image?.url || '',
    })),
  }));

  return Response.json({
    success: true,
    customer_id: customerId,
    email: email,
    orders_count: orders.length,
    orders,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleGetOrders(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleGetOrders(request);
}
