
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (session?.accessToken) {
    (globalThis as any).__SHOPIFY_ADMIN_TOKEN__ = session.accessToken;
    console.log("==================================================");
    console.log("🔑 SHOPIFY_ADMIN_ACCESS_TOKEN FOR RENDER ENV:");
    console.log(session.accessToken);
    console.log("==================================================");
  }
  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
