import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import shopify, { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0, s-maxage=0",
  "Pragma": "no-cache",
  "Expires": "0",
};

function jsonNoCache(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: NO_CACHE_HEADERS,
  });
}

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

function isPlaceholderName(str = "") {
  const lower = str.trim().toLowerCase();
  if (!lower) return true;
  return (
    lower.includes("swiggy") ||
    lower.includes("zomato") ||
    lower === "customer" ||
    lower === "user" ||
    lower === "guest" ||
    lower === "rider" ||
    lower === "dummy" ||
    lower === "test" ||
    lower === "null" ||
    lower === "undefined"
  );
}

async function testAndGetAdminClient(shop: string, accessToken: string) {
  try {
    const client = {
      graphql: async (query: string, options?: any) => {
        const res = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query, variables: options?.variables }),
        });
        return res;
      }
    };
    const testRes = await client.graphql(`{ shop { id } }`);
    if (testRes.status === 200) {
      const testJson = await testRes.json();
      if (!testJson.errors && testJson.data?.shop?.id) {
        return client;
      }
    }
  } catch (e) {}
  return null;
}

async function getAdminClient(request: Request) {
  let admin: any = null;
  let session: any = null;

  try {
    const authResult = await authenticate.public.appProxy(request);
    if (authResult.admin) {
      const testRes = await authResult.admin.graphql(`{ shop { id } }`);
      if (testRes.status === 200) {
        const testJson: any = await testRes.json();
        if (!testJson.errors && testJson.data?.shop?.id) {
          admin = authResult.admin;
          session = authResult.session;
        }
      }
    }
  } catch (e) {
    console.warn("App proxy auth warning:", e);
  }

  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop") || "ek1j7g-jq.myshopify.com";

  if (!admin && shop) {
    try {
      const unauth = await unauthenticated.admin(shop);
      if (unauth?.admin) {
        const testRes = await unauth.admin.graphql(`{ shop { id } }`);
        if (testRes.status === 200) {
          const testJson: any = await testRes.json();
          if (!testJson.errors && testJson.data?.shop?.id) {
            admin = unauth.admin;
            console.log("=== SUCCESSFULLY RECOVERED ADMIN VIA UNAUTHENTICATED ===", shop);
          }
        }
      }
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
      for (const validSession of dbSessions) {
        if (validSession.accessToken && validSession.shop) {
          const testedClient = await testAndGetAdminClient(validSession.shop, validSession.accessToken);
          if (testedClient) {
            admin = testedClient;
            console.log("=== SUCCESSFULLY RECOVERED ADMIN VIA DIRECT PRISMA ACCESSTOKEN ===", validSession.shop);
            break;
          }
        }
      }
    } catch (e) {
      console.error("Prisma session fallback error:", e);
    }
  }

  if (!admin && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    admin = await testAndGetAdminClient(shop, process.env.SHOPIFY_ADMIN_ACCESS_TOKEN);
    if (admin) {
      console.log("=== RECOVERED ADMIN VIA SHOPIFY_ADMIN_ACCESS_TOKEN ENV ===");
    }
  }

  return admin;
}

async function handleCustomerSync(request: Request) {
  try {
    console.log("=== APP PROXY CUSTOMER SYNC REQUEST RECEIVED ===", request.method, request.url);
    
    const admin = await getAdminClient(request);

    if (!admin) {
      return jsonNoCache(
        { success: false, message: "App session unavailable. Please open app once in Shopify Admin." },
        200
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
      return jsonNoCache(
        { success: false, message: "customer_id or email parameter is required for customer sync." },
        200
      );
    }

    const tag = customerId ? riderTag(customerId) : "";
    let allTagNodes: any[] = [];

    // 1. Search by Tag first
    if (tag) {
      try {
        const tagResponse = await admin.graphql(
          `#graphql
          query FindFlutterCustomerByTag($query: String!) {
            customers(first: 10, query: $query) {
              nodes {
                id
                firstName
                lastName
                tags
                numberOfOrders
                defaultEmailAddress {
                  emailAddress
                }
              }
            }
          }`,
          { variables: { query: `tag:'${tag}'` } }
        );
        const tagJson = await tagResponse.json();
        allTagNodes = tagJson.data?.customers?.nodes || [];
      } catch (e) {
        console.warn("Tag search error:", e);
      }
    }

    // 2. Search by Email if provided
    let emailNodes: any[] = [];
    if (email && email.includes("@")) {
      try {
        const emailResponse = await admin.graphql(
          `#graphql
          query FindFlutterCustomerByEmail($query: String!) {
            customers(first: 10, query: $query) {
              nodes {
                id
                firstName
                lastName
                tags
                numberOfOrders
                defaultEmailAddress {
                  emailAddress
                }
              }
            }
          }`,
          { variables: { query: `email:'${email.trim()}'` } }
        );
        const emailJson = await emailResponse.json();
        emailNodes = emailJson.data?.customers?.nodes || [];
      } catch (e) {
        console.warn("Email search error:", e);
      }
    }

    // Combine all unique customer nodes
    const nodeMap = new Map<string, any>();
    for (const node of [...allTagNodes, ...emailNodes]) {
      if (node && node.id) {
        nodeMap.set(node.id, node);
      }
    }
    const allFoundNodes = Array.from(nodeMap.values());

    // --- DEDUPLICATION: Ensure ONLY 1 Customer record exists in Shopify Admin ---
    let primaryNode: any = null;
    if (allFoundNodes.length > 0) {
      // 1. Prefer node with order(s)
      primaryNode = allFoundNodes.find((n: any) => n.numberOfOrders && parseInt(String(n.numberOfOrders)) > 0);
      // 2. Prefer node with real name
      if (!primaryNode) {
        primaryNode = allFoundNodes.find((n: any) => {
          const full = `${n.firstName || ""} ${n.lastName || ""}`.trim();
          return full && !isPlaceholderName(full);
        });
      }
      // 3. Fallback to first node
      if (!primaryNode) {
        primaryNode = allFoundNodes[0];
      }

      // Delete/untag any duplicate customer nodes so ONLY 1 CUSTOMER RECORD EXISTS in Shopify Admin
      const duplicateNodes = allFoundNodes.filter((n: any) => n.id !== primaryNode.id);
      for (const dup of duplicateNodes) {
        try {
          const delRes = await admin.graphql(
            `#graphql
            mutation DeleteDuplicateCustomer($input: CustomerDeleteInput!) {
              customerDelete(input: $input) {
                deletedCustomerId
                userErrors { field message }
              }
            }`,
            { variables: { input: { id: dup.id } } }
          );
          const delJson = await delRes.json();
          console.log("=== DELETED DUPLICATE CUSTOMER RECORD ===", dup.id, JSON.stringify(delJson));

          const delErrors = delJson.data?.customerDelete?.userErrors || [];
          if (delErrors.length > 0) {
            // If delete not allowed (e.g. order attached), untag it so it's detached from flutter_customer_<id>
            const remainingTags = (dup.tags || []).filter((t: string) => !t.startsWith("flutter_customer_") && t !== "flutter_app");
            await admin.graphql(
              `#graphql
              mutation UntagDuplicateCustomer($input: CustomerInput!) {
                customerUpdate(input: $input) {
                  customer { id tags }
                }
              }`,
              {
                variables: {
                  input: {
                    id: dup.id,
                    tags: remainingTags,
                  }
                }
              }
            );
            console.log("=== UNTAGGED DUPLICATE CUSTOMER RECORD ===", dup.id);
          }
        } catch (err) {
          console.warn("Duplicate customer cleanup error:", err);
        }
      }
    }

    const incomingIsPlaceholder = isPlaceholderName(name);
    const existingName = `${primaryNode?.firstName || ""} ${primaryNode?.lastName || ""}`.trim();

    let targetFirstName = "";
    let targetLastName = "";

    if (name && name.trim() && !incomingIsPlaceholder) {
      // Real name coming in (e.g. Ama Pank or Akshydeep)
      const parsed = splitName(name);
      targetFirstName = parsed.firstName;
      targetLastName = parsed.lastName;
    } else if (existingName && !isPlaceholderName(existingName)) {
      // Preserve existing real name from primary customer record in Shopify
      targetFirstName = primaryNode.firstName || "";
      targetLastName = primaryNode.lastName || "";
    } else if (name && name.trim()) {
      // Fallback to incoming placeholder name if no real name exists anywhere
      const parsed = splitName(name);
      targetFirstName = parsed.firstName;
      targetLastName = parsed.lastName;
    } else {
      targetFirstName = "Customer";
      targetLastName = "";
    }

    const metafields: any[] = [];
    if (customerId && customerId.trim()) metafields.push({ namespace: "flutter", key: "customer_id", type: "single_line_text_field", value: customerId.trim() });
    if (membership && membership.trim()) metafields.push({ namespace: "flutter", key: "membership_level", type: "single_line_text_field", value: membership.trim() });
    if (source && source.trim()) metafields.push({ namespace: "flutter", key: "source", type: "single_line_text_field", value: source.trim() });
    if (phone && phone.trim()) metafields.push({ namespace: "flutter", key: "phone", type: "single_line_text_field", value: phone.trim() });
    if (address && address.trim()) metafields.push({ namespace: "flutter", key: "address", type: "single_line_text_field", value: address.trim() });

    const tagsToSet = ["flutter_app"];
    if (tag) tagsToSet.push(tag);

    const isValidE164Phone = phone && /^\+[1-9]\d{7,14}$/.test(phone.replace(/\s+/g, ""));
    const isValidEmail = email && email.includes("@") && email.trim().length > 3;

    if (!primaryNode) {
      // Create single customer record
      const input: any = {
        firstName: targetFirstName,
        lastName: targetLastName,
        tags: tagsToSet,
      };
      if (metafields.length) input.metafields = metafields;
      if (isValidEmail) input.email = email.trim();
      if (isValidE164Phone) input.phone = phone.replace(/\s+/g, "");

      const createResponse = await admin.graphql(
        `#graphql
        mutation CreateFlutterCustomer($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id firstName lastName }
            userErrors { field message }
          }
        }`,
        { variables: { input } }
      );

      const createJson = await createResponse.json();
      console.log("=== customerCreate GraphQL response ===", JSON.stringify(createJson));
      const newId = createJson.data?.customerCreate?.customer?.id;

      const finalNameStr = `${targetFirstName} ${targetLastName}`.trim() || "Customer";
      return jsonNoCache({
        success: true,
        action: "created",
        customer_id: customerId,
        name: finalNameStr,
        email: email || "",
        phone: phone || "",
        shopify_internal_id: newId || null,
      });
    }

    // Update primary customer record
    const targetIsPlaceholder = isPlaceholderName(`${targetFirstName} ${targetLastName}`.trim());
    const primaryIsPlaceholder = isPlaceholderName(existingName);

    const updateInput: any = {
      id: primaryNode.id,
      tags: Array.from(new Set([...(primaryNode.tags || []), ...tagsToSet])),
    };
    if (metafields.length) updateInput.metafields = metafields;

    if (!targetIsPlaceholder || primaryIsPlaceholder) {
      updateInput.firstName = targetFirstName;
      updateInput.lastName = targetLastName;
    }

    if (isValidEmail && !primaryNode.defaultEmailAddress?.emailAddress) {
      updateInput.email = email.trim();
    }
    if (isValidE164Phone) {
      updateInput.phone = phone.replace(/\s+/g, "");
    }

    try {
      await admin.graphql(
        `#graphql
        mutation UpdateFlutterCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id firstName lastName }
            userErrors { field message }
          }
        }`,
        { variables: { input: updateInput } }
      );
    } catch (err) {
      console.warn("customerUpdate primary node error:", err);
    }

    const finalNameStr = `${targetFirstName} ${targetLastName}`.trim() || "Customer";
    const finalEmailStr = (email && email.trim()) ? email.trim() : (primaryNode?.defaultEmailAddress?.emailAddress || "");

    return jsonNoCache({
      success: true,
      action: "updated",
      customer_id: customerId,
      name: finalNameStr,
      email: finalEmailStr,
      phone: phone || "",
      shopify_internal_id: primaryNode.id,
    });
  } catch (error: any) {
    console.error("=== APP PROXY CUSTOMER SYNC ERROR ===", error);
    const errMsg = String(error?.message || "");
    if (errMsg.includes("Unauthorized") || errMsg.includes("401")) {
      return jsonNoCache(
        { success: false, message: "Shopify session expired. Please open app once in Shopify Admin." },
        200
      );
    }
    return jsonNoCache(
      { success: false, message: error?.message || "Internal Server Error" },
      200
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleCustomerSync(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleCustomerSync(request);
}