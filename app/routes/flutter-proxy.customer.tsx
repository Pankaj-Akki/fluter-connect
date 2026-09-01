import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

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
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) {
    return Response.json(
      { success: false, message: "App is not installed or Admin session unavailable." },
      { status: 401 }
    );
  }

  let customerId = "";
  let name = "";
  let membership = "";
  let email = "";
  let source = "flutter_app";

  if (request.method === "POST" || request.method === "PUT") {
    try {
      const body = await request.json();
      customerId = String(body.customer_id || "").trim();
      name = String(body.name || "").trim();
      membership = String(body.membership_level || "").trim();
      email = body.email ? String(body.email).trim() : "";
      source = String(body.source || "flutter_app").trim();
    } catch (e) {
      // Ignored: fallback to query params
    }
  }

  // Fallback to query parameters if fields are missing (or if GET request)
  if (!customerId || !name || !membership) {
    const url = new URL(request.url);
    customerId = String(url.searchParams.get("customer_id") || "").trim();
    name = String(url.searchParams.get("name") || "").trim();
    membership = String(url.searchParams.get("membership_level") || "").trim();
    email = url.searchParams.get("email") ? String(url.searchParams.get("email")).trim() : "";
    source = String(url.searchParams.get("source") || "flutter_app").trim();
  }

  if (!customerId || !name || !membership) {
    return Response.json(
      { success: false, message: "customer_id, name and membership_level are required." },
      { status: 400 }
    );
  }

  const tag = riderTag(customerId);
  const { firstName, lastName } = splitName(name);

  const searchQuery = email ? `tag:'${tag}' OR email:'${email}'` : `tag:'${tag}'`;

  const searchResponse = await admin.graphql(
    `#graphql
    query FindFlutterCustomer($query: String!) {
      customers(first: 2, query: $query) {
        nodes {
          id
          firstName
          lastName
          tags
          defaultEmailAddress {
            emailAddress
          }
          customerId: metafield(namespace: "flutter", key: "customer_id") {
            value
          }
          membership: metafield(namespace: "flutter", key: "membership_level") {
            value
          }
        }
      }
    }`,
    { variables: { query: searchQuery } }
  );

  const searchJson = await searchResponse.json();
  const existing = searchJson.data?.customers?.nodes?.[0];

  const metafields = [
    { namespace: "flutter", key: "customer_id", type: "single_line_text_field", value: customerId },
    { namespace: "flutter", key: "membership_level", type: "single_line_text_field", value: membership },
    { namespace: "flutter", key: "source", type: "single_line_text_field", value: source },
  ];

  if (!existing) {
    const input: any = {
      firstName,
      lastName,
      tags: [tag, "flutter_app"],
      metafields,
    };
    if (email) input.email = email;

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
      shopify_internal_id: createJson.data.customerCreate.customer.id,
    });
  }

  const updateInput: any = {
    id: existing.id,
    firstName,
    lastName,
    tags: Array.from(new Set([...(existing.tags || []), tag, "flutter_app"])),
    metafields,
  };
  if (email) updateInput.email = email;

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
    shopify_internal_id: existing.id,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleCustomerSync(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleCustomerSync(request);
}