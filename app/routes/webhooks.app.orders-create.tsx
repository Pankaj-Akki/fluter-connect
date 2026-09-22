import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

function riderTag(customerId: string) {
  return `flutter_customer_${customerId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { shop, topic, payload } = await authenticate.webhook(request);
    if (topic !== "ORDERS_CREATE") {
      return new Response("Ignored", { status: 200 });
    }

    console.log("=== ORDERS_CREATE WEBHOOK RECEIVED ===", payload.id, shop);

    const attributes = Array.isArray(payload.note_attributes)
      ? Object.fromEntries(
          payload.note_attributes.map((item: any) => [item.name, item.value])
        )
      : {};

    const customerId = attributes.customer_id || payload.note || null;
    const checkoutCustomer = payload.customer;

    console.log("=== WEBHOOK ATTRIBUTES ===", { customerId, checkoutCustomer });

    if (shop) {
      const { admin } = await unauthenticated.admin(shop);

      if (admin) {
        const checkoutFirstName = checkoutCustomer?.first_name || "";
        const checkoutLastName = checkoutCustomer?.last_name || "";
        const checkoutEmail = checkoutCustomer?.email || "";
        const checkoutPhone = checkoutCustomer?.phone || "";

        // If customer_id is present from cart/checkout
        if (customerId) {
          const tag = riderTag(customerId);
          const tagsToSet = ["flutter_app", tag];

          // 1. Tag & update the checkout customer if present
          if (checkoutCustomer?.id) {
            const checkoutGid = `gid://shopify/Customer/${checkoutCustomer.id}`;
            const metafields = [
              { namespace: "flutter", key: "customer_id", type: "single_line_text_field", value: String(customerId).trim() }
            ];
            if (attributes.membership_level) {
              metafields.push({ namespace: "flutter", key: "membership_level", type: "single_line_text_field", value: String(attributes.membership_level).trim() });
            }
            if (attributes.source) {
              metafields.push({ namespace: "flutter", key: "source", type: "single_line_text_field", value: String(attributes.source).trim() });
            }

            try {
              await admin.graphql(
                `#graphql
                mutation UpdateCheckoutCustomer($input: CustomerInput!) {
                  customerUpdate(input: $input) {
                    customer { id firstName lastName tags }
                    userErrors { field message }
                  }
                }`,
                {
                  variables: {
                    input: {
                      id: checkoutGid,
                      tags: tagsToSet,
                      metafields,
                    }
                  }
                }
              );
              console.log("=== UPDATED CHECKOUT CUSTOMER WITH FLUTTER TAG & METAFIELD ===", checkoutGid, tag);
            } catch (err) {
              console.warn("Error updating checkout customer:", err);
            }
          }

          // 2. Find any previously created duplicate customer records for this flutter customer_id (e.g. Swiggy Rider) and delete/untag them so ONLY 1 customer record exists in Shopify Admin!
          try {
            const findResponse = await admin.graphql(
              `#graphql
              query FindFlutterCustomers($query: String!) {
                customers(first: 10, query: $query) {
                  nodes {
                    id
                    firstName
                    lastName
                    tags
                    numberOfOrders
                  }
                }
              }`,
              { variables: { query: `tag:'${tag}'` } }
            );
            const findJson = await findResponse.json();
            const nodes = findJson.data?.customers?.nodes || [];
            const checkoutGid = checkoutCustomer?.id ? `gid://shopify/Customer/${checkoutCustomer.id}` : null;

            for (const node of nodes) {
              if (checkoutGid && node.id === checkoutGid) {
                // Update checkout customer name & details
                const updateInput: any = {
                  id: node.id,
                  tags: Array.from(new Set([...(node.tags || []), ...tagsToSet])),
                };
                if (checkoutFirstName) updateInput.firstName = checkoutFirstName;
                if (checkoutLastName) updateInput.lastName = checkoutLastName;
                if (checkoutEmail && checkoutEmail.includes("@")) updateInput.email = checkoutEmail;
                if (checkoutPhone && /^\+[1-9]\d{7,14}$/.test(checkoutPhone.replace(/\s+/g, ""))) {
                  updateInput.phone = checkoutPhone.replace(/\s+/g, "");
                }

                await admin.graphql(
                  `#graphql
                  mutation SyncCheckoutCustomerDetails($input: CustomerInput!) {
                    customerUpdate(input: $input) {
                      customer { id firstName lastName email }
                      userErrors { field message }
                    }
                  }`,
                  { variables: { input: updateInput } }
                );
              } else if (checkoutGid && node.id !== checkoutGid) {
                // Delete duplicate 0-order placeholder customer node created before checkout!
                try {
                  const delRes = await admin.graphql(
                    `#graphql
                    mutation DeleteDupInWebhook($input: CustomerDeleteInput!) {
                      customerDelete(input: $input) {
                        deletedCustomerId
                        userErrors { field message }
                      }
                    }`,
                    { variables: { input: { id: node.id } } }
                  );
                  const delJson = await delRes.json();
                  console.log("=== WEBHOOK DELETED DUPLICATE CUSTOMER RECORD ===", node.id, JSON.stringify(delJson));

                  const delErrors = delJson.data?.customerDelete?.userErrors || [];
                  if (delErrors.length > 0) {
                    const remainingTags = (node.tags || []).filter((t: string) => !t.startsWith("flutter_customer_") && t !== "flutter_app");
                    await admin.graphql(
                      `#graphql
                      mutation UntagDupInWebhook($input: CustomerInput!) {
                        customerUpdate(input: $input) {
                          customer { id tags }
                        }
                      }`,
                      {
                        variables: {
                          input: {
                            id: node.id,
                            tags: remainingTags,
                          }
                        }
                      }
                    );
                    console.log("=== WEBHOOK UNTAGGED DUPLICATE CUSTOMER RECORD ===", node.id);
                  }
                } catch (delErr) {
                  console.warn("Webhook delete duplicate error:", delErr);
                }
              }
            }
          } catch (err) {
            console.warn("Error syncing flutter customer details in webhook:", err);
          }
        } else if (checkoutEmail && checkoutEmail.includes("@")) {
          // If no customer_id in note_attributes, attempt lookup by checkout email
          try {
            const findByEmail = await admin.graphql(
              `#graphql
              query FindFlutterByEmail($query: String!) {
                customers(first: 10, query: $query) {
                  nodes {
                    id
                    firstName
                    lastName
                    tags
                    customerIdMetafield: metafield(namespace: "flutter", key: "customer_id") { value }
                  }
                }
              }`,
              { variables: { query: `email:'${checkoutEmail.trim()}'` } }
            );
            const emailJson = await findByEmail.json();
            const emailNodes = emailJson.data?.customers?.nodes || [];

            for (const node of emailNodes) {
              const matchedTag = (node.tags || []).find((t: string) => t.startsWith("flutter_customer_"));
              const matchedMeta = node.customerIdMetafield?.value;
              const fId = matchedMeta || (matchedTag ? matchedTag.replace("flutter_customer_", "") : null);

              if (fId && checkoutCustomer?.id) {
                const checkoutGid = `gid://shopify/Customer/${checkoutCustomer.id}`;
                const tag = riderTag(fId);
                await admin.graphql(
                  `#graphql
                  mutation TagCheckoutCustomerByEmail($input: CustomerInput!) {
                    customerUpdate(input: $input) {
                      customer { id tags }
                    }
                  }`,
                  {
                    variables: {
                      input: {
                        id: checkoutGid,
                        tags: Array.from(new Set([...(checkoutCustomer.tags || []), "flutter_app", tag])),
                        metafields: [
                          { namespace: "flutter", key: "customer_id", type: "single_line_text_field", value: fId }
                        ]
                      }
                    }
                  }
                );
                console.log("=== LINKED CHECKOUT CUSTOMER BY EMAIL MATCH ===", checkoutGid, fId);
              }
            }
          } catch (err) {
            console.warn("Error finding customer by email:", err);
          }
        }
      }
    }
  } catch (error) {
    console.error("=== ORDERS_CREATE WEBHOOK ERROR ===", error);
  }

  return new Response("OK", { status: 200 });
};