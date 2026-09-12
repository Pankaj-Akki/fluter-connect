import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

async function handleGetOrders(request: Request) {
  try {
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

    console.log(`=== ORDERS PROXY INPUT: customerId="${customerId}", email="${email}" ===`);

    if (!customerId && !email) {
      return Response.json(
        { success: false, message: "customer_id or email parameter is required." },
        { status: 400 }
      );
    }

    const rawId = customerId.toLowerCase();
    const cleanNum = rawId.replace(/^r/i, "");
    const targetEmail = email.toLowerCase();

    // Fetch recent orders & customers directly without relying on complex search syntax parser
    const response = await admin.graphql(
      `#graphql
      query FetchStoreOrdersAndCustomers {
        customers(first: 50) {
          nodes {
            id
            email
            firstName
            lastName
            tags
            customerIdMetafield: metafield(namespace: "flutter", key: "customer_id") {
              value
            }
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
        recentOrders: orders(first: 50, sortKey: CREATED_AT, reverse: true) {
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
              customerIdMetafield: metafield(namespace: "flutter", key: "customer_id") {
                value
              }
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
      }`
    );

    const json = await response.json();
    const customerNodes = json.data?.customers?.nodes || [];
    const recentOrders = json.data?.recentOrders?.nodes || [];

    const map = new Map<string, any>();

    // Function to check if a customer node matches the target customerId or email
    function isCustomerMatch(cust: any) {
      if (!cust) return false;

      // 1. Email match
      if (targetEmail && cust.email && cust.email.toLowerCase() === targetEmail) {
        return true;
      }

      // 2. Metafield match
      const metaValue = String(cust.customerIdMetafield?.value || "").toLowerCase();
      if (rawId && metaValue && (metaValue === rawId || metaValue === cleanNum || metaValue === `r${cleanNum}`)) {
        return true;
      }

      // 3. Tag match
      const tags = (cust.tags || []).map((t: string) => t.toLowerCase());
      if (rawId) {
        const matchTag = tags.some((t: string) => 
          t.includes(rawId) || 
          t.includes(`flutter_customer_${rawId}`) || 
          t.includes(`flutter_customer_${cleanNum}`) || 
          t.includes(`flutter_customer_r${cleanNum}`) || 
          t === rawId || 
          t === cleanNum || 
          t === `r${cleanNum}`
        );
        if (matchTag) return true;
      }

      return false;
    }

    // A. Check customer list and collect their orders
    for (const cust of customerNodes) {
      if (isCustomerMatch(cust)) {
        const custOrders = cust.orders?.nodes || [];
        for (const o of custOrders) {
          if (!map.has(o.id)) {
            map.set(o.id, o);
          }
        }
      }
    }

    // B. Check recent store orders for matching customer info
    for (const o of recentOrders) {
      if (isCustomerMatch(o.customer) && !map.has(o.id)) {
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

    console.log(`=== ORDERS FOUND FOR CUSTOMER: count=${orders.length} ===`);

    return Response.json({
      success: true,
      customer_id: customerId,
      email: email,
      orders_count: orders.length,
      orders,
    });
  } catch (error: any) {
    console.error("=== APP PROXY ORDERS ERROR ===", error);
    return Response.json(
      { success: false, message: error?.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleGetOrders(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleGetOrders(request);
}
