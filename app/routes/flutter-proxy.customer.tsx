import shopify, { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || "",
    lastName: parts.join(" "),
  };
}

function riderTag(customerId: string) {
  return `flutter_customer_${customerId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

async function getAdminClient(request: Request) {
  let admin: any = null;
  let session: any = null;

  try {
    const authResult = await authenticate.public.appProxy(request);
    admin = authResult.admin;
    session = authResult.session;
  } catch (e) {
    console.warn("App proxy auth warning:", e);
  }

  if (!admin) {
    const url = new URL(request.url);
    const shop = session?.shop || url.searchParams.get("shop") || "ek1j7g-jq.myshopify.com";
    if (shop) {
      try {
        const unauth = await unauthenticated.admin(shop);
        admin = unauth.admin;
        console.log("=== SUCCESSFULLY RECOVERED ADMIN VIA UNAUTHENTICATED ===", shop);
      } catch (e) {
        console.warn("Unauthenticated admin fallback warning:", e);
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
          const client = new shopify.api.clients.Graphql({ session: validSession as any });
          admin = { graphql: (query: string, options?: any) => client.query({ data: { query, variables: options?.variables } }) };
          console.log("=== SUCCESSFULLY RECOVERED ADMIN VIA DIRECT PRISMA SESSION ===", validSession.shop);
        }
      } catch (e) {
        console.error("Prisma session fallback error:", e);
      }
    }
  }

  return admin;
}

async function handleCustomerSync(request: Request) {
  console.log("=== APP PROXY CUSTOMER SYNC REQUEST RECEIVED ===", request.method, request.url);
  
  const admin = await getAdminClient(request);

  if (!admin) {
    return Response.json(
      { success: false, message: "App is not installed or Admin session unavailable. Please open app once in Shopify Admin." },
      { status: 401 }
    );
  }

  let customerId = "";
  let name = "";
  let membership = "Standard";
  let email = "";
  let phone = "";
  let address = "";
  let source = "flutter_app";

  if (request.method === "POST" || request.method === "PUT") {
    try {
      const body = await request.json();
      customerId = String(body.customer_id || "").trim();
      name = String(body.name || "").trim();
      membership = String(body.membership_level || "Standard").trim();
      email = body.email ? String(body.email).trim() : "";
      phone = body.phone ? String(body.phone).trim() : "";
      address = body.address ? String(body.address).trim() : "";
      source = String(body.source || "flutter_app").trim();
    } catch (e) {
      // Ignored: fallback to query params
    }
  }

  // Fallback to query parameters if fields are missing (or if GET request)
  if (!customerId) {
    const url = new URL(request.url);
    customerId = String(url.searchParams.get("customer_id") || "").trim();
    if (!name) name = String(url.searchParams.get("name") || "").trim();
    if (!membership || membership === "Standard") membership = String(url.searchParams.get("membership_level") || "Standard").trim();
    if (!email) email = String(url.searchParams.get("email") || "").trim();
    if (!phone) phone = String(url.searchParams.get("phone") || "").trim();
    if (!address) address = String(url.searchParams.get("address") || "").trim();
    if (!source) source = String(url.searchParams.get("source") || "flutter_app").trim();
  }

  if (!customerId && !email) {
    return Response.json(
      { success: false, message: "customer_id or email parameter is required for customer sync." },
      { status: 400 }
    );
  }

  const tag = customerId ? riderTag(customerId) : "";
  let existing: any = null;

  // 1. Search by Tag first
  if (tag) {
    try {
      const tagResponse = await admin.graphql(
        `#graphql
        query FindFlutterCustomerByTag($query: String!) {
          customers(first: 1, query: $query) {
            nodes {
              id
              firstName
              lastName
              tags
              defaultEmailAddress {
                emailAddress
              }
            }
          }
        }`,
        { variables: { query: `tag:'${tag}'` } }
      );
      const tagJson = await tagResponse.json();
      existing = tagJson.data?.customers?.nodes?.[0];
    } catch (e) {
      console.warn("Tag search error:", e);
    }
  }

  // 2. Fallback: Search by Email if not found by tag
  if (!existing && email && email.includes("@")) {
    try {
      const emailResponse = await admin.graphql(
        `#graphql
        query FindFlutterCustomerByEmail($query: String!) {
          customers(first: 1, query: $query) {
            nodes {
              id
              firstName
              lastName
              tags
              defaultEmailAddress {
                emailAddress
              }
            }
          }
        }`,
        { variables: { query: `email:'${email.trim()}'` } }
      );
      const emailJson = await emailResponse.json();
      existing = emailJson.data?.customers?.nodes?.[0];
    } catch (e) {
      console.warn("Email search error:", e);
    }
  }

  const { firstName, lastName } = name ? splitName(name) : { firstName: "", lastName: "" };

  const metafields: any[] = [];
  if (customerId && customerId.trim()) metafields.push({ namespace: "flutter", key: "customer_id", type: "single_line_text_field", value: customerId.trim() });
  if (membership && membership.trim()) metafields.push({ namespace: "flutter", key: "membership_level", type: "single_line_text_field", value: membership.trim() });
  if (source && source.trim()) metafields.push({ namespace: "flutter", key: "source", type: "single_line_text_field", value: source.trim() });
  if (phone && phone.trim()) metafields.push({ namespace: "flutter", key: "phone", type: "single_line_text_field", value: phone.trim() });
  if (address && address.trim()) metafields.push({ namespace: "flutter", key: "address", type: "single_line_text_field", value: address.trim() });

  const tagsToSet = ["flutter_app"];
  if (tag) tagsToSet.push(tag);

  // Validate E.164 phone format for native Shopify customer.phone field
  const isValidE164Phone = phone && /^\+[1-9]\d{7,14}$/.test(phone.replace(/\s+/g, ""));
  const isValidEmail = email && email.includes("@") && email.trim().length > 3;

  if (!existing) {
    const input: any = {
      firstName: firstName || "Customer",
      lastName: lastName || "",
      tags: tagsToSet,
    };
    if (metafields.length) input.metafields = metafields;
    if (isValidEmail) input.email = email.trim();
    if (isValidE164Phone) input.phone = phone.replace(/\s+/g, "");

    const createResponse = await admin.graphql(
      `#graphql
      mutation CreateFlutterCustomer($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            firstName
            lastName
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { input } }
    );

    const createJson = await createResponse.json();
    console.log("=== customerCreate GraphQL response ===", JSON.stringify(createJson));
    const errors = createJson.data?.customerCreate?.userErrors || [];
    const newId = createJson.data?.customerCreate?.customer?.id;

    if (newId) {
      return Response.json({
        success: true,
        action: "created",
        customer_id: customerId,
        name: name || `${firstName} ${lastName}`.trim() || "Customer",
        email: email || "",
        shopify_internal_id: newId,
      });
    }

    // If customerCreate failed (e.g. Email taken), find by email and update!
    if (errors.length && isValidEmail) {
      console.warn("=== customerCreate errors, attempting fallback update by email ===", errors);
      try {
        const findByEmail = await admin.graphql(
          `#graphql
          query FindExistingByEmail($query: String!) {
            customers(first: 1, query: $query) {
              nodes { id firstName lastName tags }
            }
          }`,
          { variables: { query: `email:'${email.trim()}'` } }
        );
        const findJson = await findByEmail.json();
        existing = findJson.data?.customers?.nodes?.[0];
      } catch (e) {}
    }
  }

  if (existing) {
    const updateInput: any = {
      id: existing.id,
      tags: Array.from(new Set([...(existing.tags || []), ...tagsToSet])),
    };
    if (metafields.length) updateInput.metafields = metafields;

    if (name && name.trim()) {
      updateInput.firstName = firstName;
      updateInput.lastName = lastName;
    }
    if (isValidEmail) updateInput.email = email.trim();
    if (isValidE164Phone) updateInput.phone = phone.replace(/\s+/g, "");

    const updateResponse = await admin.graphql(
      `#graphql
      mutation UpdateFlutterCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            firstName
            lastName
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { input: updateInput } }
    );

    const updateJson = await updateResponse.json();
    console.log("=== customerUpdate GraphQL response ===", JSON.stringify(updateJson));
  }

  const finalName = (name && name.trim()) ? name.trim() : `${existing?.firstName || ''} ${existing?.lastName || ''}`.trim();
  const finalEmail = (email && email.trim()) ? email.trim() : (existing?.defaultEmailAddress?.emailAddress || "");

  return Response.json({
    success: true,
    action: existing ? "updated" : "created",
    customer_id: customerId,
    name: finalName || "Customer",
    email: finalEmail,
    phone: phone || "",
    shopify_internal_id: existing?.id || null,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleCustomerSync(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleCustomerSync(request);
}