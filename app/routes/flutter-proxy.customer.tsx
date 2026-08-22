import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || "",
    lastName: parts.join(" "),
  };
}

function riderTag(customerId: string) {
  return `flutter_customer_${customerId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) {
    return Response.json(
      { success: false, message: "App is not installed or Admin session unavailable." },
      { status: 401 }
    );
  }

  const body = await request.json();
  const customerId = String(body.customer_id || "").trim();
  const name = String(body.name || "").trim();
  const membership = String(body.membership_level || "").trim();
  const email = body.email ? String(body.email).trim() : "";
  const source = String(body.source || "flutter_app").trim();

  if (!customerId || !name || !membership) {
    return Response.json(
      { success: false, message: "customer_id, name and membership_level are required." },
      { status: 400 }
    );
  }

  const tag = riderTag(customerId);
  const { firstName, lastName } = splitName(name);

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
    { variables: { query: `tag:${tag}` } }
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
    const errors = createJson.data?.customerCreate?.userErrors || [];
    if (errors.length) {
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
  const errors = updateJson.data?.customerUpdate?.userErrors || [];
  if (errors.length) {
    return Response.json({ success: false, errors }, { status: 422 });
  }

  return Response.json({
    success: true,
    action: "updated",
    customer_id: customerId,
    shopify_internal_id: existing.id,
  });
}