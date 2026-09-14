import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

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

async function handleCustomerSync(request: Request) {
  console.log("=== APP PROXY CUSTOMER SYNC REQUEST RECEIVED ===", request.method, request.url);
  
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
        console.error("Unauthenticated admin fallback failed:", e);
      }
    }
  }

  if (!admin) {
    return Response.json(
      { success: false, message: "App is not installed or Admin session unavailable." },
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
  if (!existing && email) {
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
            }
          }
        }`,
        { variables: { query: `email:'${email}'` } }
      );
      const emailJson = await emailResponse.json();
      existing = emailJson.data?.customers?.nodes?.[0];
    } catch (e) {
      console.warn("Email search error:", e);
    }
  }

  const { firstName, lastName } = name ? splitName(name) : { firstName: "Customer", lastName: "" };

  const metafields: any[] = [];
  if (customerId) metafields.push({ namespace: "flutter", key: "customer_id", type: "single_line_text_field", value: customerId });
  if (membership) metafields.push({ namespace: "flutter", key: "membership_level", type: "single_line_text_field", value: membership });
  if (source) metafields.push({ namespace: "flutter", key: "source", type: "single_line_text_field", value: source });
  if (phone) metafields.push({ namespace: "flutter", key: "phone", type: "single_line_text_field", value: phone });
  if (address) metafields.push({ namespace: "flutter", key: "address", type: "single_line_text_field", value: address });

  const tagsToSet = ["flutter_app"];
  if (tag) tagsToSet.push(tag);

  if (!existing) {
    const input: any = {
      firstName: firstName || "Customer",
      lastName: lastName || "",
      tags: tagsToSet,
      metafields,
    };
    if (email) input.email = email;
    if (phone) input.phone = phone;

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
    if (errors.length) {
      console.error("=== customerCreate userErrors ===", errors);
      return Response.json({ success: false, errors }, { status: 422 });
    }

    return Response.json({
      success: true,
      action: "created",
      customer_id: customerId,
      shopify_internal_id: createJson.data?.customerCreate?.customer?.id,
    });
  }

  const updateInput: any = {
    id: existing.id,
    tags: Array.from(new Set([...(existing.tags || []), ...tagsToSet])),
    metafields,
  };
  if (name) {
    updateInput.firstName = firstName;
    updateInput.lastName = lastName;
  }
  if (email) updateInput.email = email;
  if (phone) updateInput.phone = phone;

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
  const errors = updateJson.data?.customerUpdate?.userErrors || [];
  if (errors.length) {
    console.error("=== customerUpdate userErrors ===", errors);
    return Response.json({ success: false, errors }, { status: 422 });
  }

  return Response.json({
    success: true,
    action: "updated",
    customer_id: customerId,
    name: `${firstName} ${lastName}`.trim(),
    email: email,
    phone: phone,
    shopify_internal_id: existing.id,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleCustomerSync(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleCustomerSync(request);
}