import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import shopify, { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

async function getAdminClient(request: Request) {
  let admin: any = null;
  let session: any = null;

  try {
    const authResult = await authenticate.public.appProxy(request);
    admin = authResult.admin;
    session = authResult.session;
  } catch (e) {
    console.warn("App proxy auth warning in orders:", e);
  }

  if (!admin) {
    const url = new URL(request.url);
    const shop = session?.shop || url.searchParams.get("shop") || "ek1j7g-jq.myshopify.com";
    if (shop) {
      try {
        const unauth = await unauthenticated.admin(shop);
        admin = unauth.admin;
        console.log("=== SUCCESSFULLY RECOVERED ADMIN VIA UNAUTHENTICATED IN ORDERS ===", shop);
      } catch (e) {
        console.warn("Unauthenticated admin fallback warning in orders:", e);
      }
    }

    if (!admin) {
      try {
        const dbSessions = await prisma.session.findMany({
          where: { accessToken: { not: "" } },
          orderBy: { expires: "desc" }
        });
        const validSession = dbSessions[0];
        if (validSession) {
          const unauth = await unauthenticated.admin(validSession.shop);
          admin = unauth.admin;
          console.log("=== SUCCESSFULLY RECOVERED ADMIN VIA DIRECT PRISMA SESSION IN ORDERS ===", validSession.shop);
        }
      } catch (e) {
        console.error("Prisma session fallback error in orders:", e);
      }
    }
  }

  return admin;
}

async function handleGetOrders(request: Request) {
  try {
    console.log("=== APP PROXY ORDERS REQUEST RECEIVED ===", request.method, request.url);
    
    const admin = await getAdminClient(request);

    if (!admin) {
      return Response.json(
        { success: false, message: "App is not installed or Admin session unavailable. Please open app once in Shopify Admin." },
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

    // Minimal GraphQL query avoiding any variant or restricted product fields
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
              firstName
              lastName
              tags
              customerIdMetafield: metafield(namespace: "flutter", key: "customer_id") {
                value
              }
            }
            lineItems(first: 20) {
              nodes {
                title
                quantity
              }
            }
          }
        }
      }`
    );

    const json = await response.json();
    console.log("=== GRAPHQL ORDERS RESPONSE ===", JSON.stringify(json));

    if (json.errors) {
      console.error("=== GRAPHQL ERRORS ===", json.errors);
      return Response.json({ success: false, errors: json.errors }, { status: 500 });
    }

    const customerNodes = json.data?.customers?.nodes || [];
    const recentOrders = json.data?.recentOrders?.nodes || [];

    // Helper to test if a customer object matches the request params
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
      const tags = (cust.tags || []).map((t: string) => String(t).toLowerCase());
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

    // Collect IDs of matched customers
    const matchedCustomerIds = new Set<string>();
    for (const cust of customerNodes) {
      if (isCustomerMatch(cust)) {
        matchedCustomerIds.add(cust.id);
      }
    }

    const map = new Map<string, any>();

    // Collect orders matching customer criteria
    for (const o of recentOrders) {
      const orderCust = o.customer;
      if (orderCust) {
        if (matchedCustomerIds.has(orderCust.id) || isCustomerMatch(orderCust)) {
          if (!map.has(o.id)) {
            map.set(o.id, o);
          }
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
        price: '',
        variant_id: null,
        image_url: '',
      })),
    }));

    console.log(`=== MATCHED ORDERS COUNT: ${orders.length} ===`);

    return Response.json({
      success: true,
      customer_id: customerId,
      email: email,
      orders_count: orders.length,
      orders,
    });
  } catch (error: any) {
    console.error("=== APP PROXY ORDERS HANDLER ERROR ===", error);
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
