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

  const tag = riderTag(customerId);

  // Search customer orders by tag or metafield query
  const response = await admin.graphql(
    `#graphql
    query FindCustomerOrders($customerQuery: String!, $orderQuery: String!) {
      customers(first: 1, query: $customerQuery) {
        nodes {
          id
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
      directOrders: orders(first: 25, query: $orderQuery, sortKey: CREATED_AT, reverse: true) {
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
      variables: {
        customerQuery: `tag:'${tag}' OR tag:'${customerId}'`,
        orderQuery: `tag:'${tag}' OR tag:'${customerId}'`,
      },
    }
  );

  const json = await response.json();
  const customerNode = json.data?.customers?.nodes?.[0];
  const customerOrders = customerNode?.orders?.nodes || [];
  const directOrders = json.data?.directOrders?.nodes || [];

  // Combine and deduplicate orders by ID
  const map = new Map<string, any>();
  for (const o of [...customerOrders, ...directOrders]) {
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
