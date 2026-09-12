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
  let customerId = url.searchParams.get("customer_id") || "";

  if (!customerId && (request.method === "POST" || request.method === "PUT")) {
    try {
      const body = await request.json();
      customerId = body.customer_id || "";
    } catch (e) {
      // Ignored
    }
  }

  if (!customerId) {
    return Response.json(
      { success: false, message: "customer_id parameter is required." },
      { status: 400 }
    );
  }

  // Normalize customerId (handle both "521" and "R521")
  const rawId = customerId.trim();
  const cleanNum = rawId.replace(/^R/i, "");
  
  const tag1 = riderTag(rawId);          // e.g. flutter_customer_521 or flutter_customer_R521
  const tag2 = riderTag(`R${cleanNum}`); // e.g. flutter_customer_R521
  const tag3 = riderTag(cleanNum);       // e.g. flutter_customer_521

  const searchQuery = `tag:'${tag1}' OR tag:'${tag2}' OR tag:'${tag3}' OR tag:'${rawId}' OR tag:'R${cleanNum}' OR tag:'${cleanNum}'`;

  console.log("=== APP PROXY ORDERS SEARCH QUERY ===", searchQuery);

  // Search customer orders by tag or metafield query
  const response = await admin.graphql(
    `#graphql
    query FindCustomerOrders($query: String!) {
      customers(first: 5, query: $query) {
        nodes {
          id
          firstName
          lastName
          email
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
      directOrders: orders(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
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
    }`,
    {
      variables: { query: searchQuery }
    }
  );

  const json = await response.json();
  const customerNodes = json.data?.customers?.nodes || [];
  
  // Aggregate all orders from matching customers & direct orders
  const map = new Map<string, any>();

  for (const cust of customerNodes) {
    const custOrders = cust.orders?.nodes || [];
    for (const o of custOrders) {
      if (!map.has(o.id)) {
        map.set(o.id, o);
      }
    }
  }

  const directOrders = json.data?.directOrders?.nodes || [];
  for (const o of directOrders) {
    if (!map.has(o.id)) {
      map.set(o.id, o);
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
