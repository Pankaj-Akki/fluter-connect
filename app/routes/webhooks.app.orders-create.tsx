import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (topic !== "ORDERS_CREATE") {
    return new Response("Ignored", { status: 200 });
  }

  const attributes = Array.isArray(payload.note_attributes)
    ? Object.fromEntries(
        payload.note_attributes.map((item: any) => [item.name, item.value])
      )
    : {};

  const integrationOrder = {
    shop,
    order_id: payload.id,
    order_number: payload.order_number,
    customer_id: attributes.customer_id || null,
    membership_level: attributes.membership_level || null,
    source: attributes.source || null,
    amount: payload.total_price,
    currency: payload.currency,
    products: payload.line_items || [],
  };

  console.log("Flutter order:", integrationOrder);

  return new Response("OK", { status: 200 });
};