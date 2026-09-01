# Shopify App Sync Development & Deployment Runbook

Follow these steps to launch the tunnel, update the Shopify configuration, start the backend server, and test the integration end-to-end.

---

## 🛠️ Step 1: Start the Tunnel
Get a public HTTPS address by running the persistent SSH tunnel command:
```bash
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 nokey@localhost.run
```
*Note down the generated tunnel URL from the terminal output (e.g., `https://xxxxxx.lhr.life`).*

---

## 📝 Step 2: Update Configuration Files
Copy the new tunnel URL and paste it in the following two files:

1. **`.env`** (in the root directory):
   ```env
   SHOPIFY_APP_URL=https://xxxxxx.lhr.life
   ```

2. **`shopify.app.toml`** (in the root directory):
   ```toml
   application_url = "https://xxxxxx.lhr.life"

   [auth]
   redirect_urls = [ "https://xxxxxx.lhr.life/auth/callback" ]
   ```

---

## 🚀 Step 3: Deploy configuration to Shopify
Push the updated settings to your Shopify Developer Dashboard:
```bash
npx shopify app deploy --allow-updates
```

---

## 🔑 Step 4: Clear Old Sessions & Re-authenticate
To prevent access token conflicts and force Shopify storefront to clear its CDN routing cache immediately:

1. **Clear local sessions** from the SQLite database:
   ```bash
   sqlite3 prisma/dev.sqlite "DELETE FROM Session"
   ```

2. **Uninstall the app** from the store:
   * Go to **Shopify Admin** -> **Settings** -> **Apps and sales channels**.
   * Find **`flutter-new-app`** and click **Uninstall**.

3. **Reinstall the app**:
   * Open the app installation link:
     👉 `https://admin.shopify.com/store/orbis-3664/apps/flutter-new-app`
   * Click **Install app** to generate a new active access token.

---

## 🖥️ Step 5: Start the Server
Start the local server to handle incoming storefront proxy requests:
```bash
node --env-file=.env node_modules/@react-router/serve/bin.js ./build/server/index.js
```

---

## 🧪 Step 6: Test the Integration
Open a browser tab (or send to anyone on any PC) and load the test URL:
```text
https://orbis-3664.myshopify.com/?customer_id=R458&name=John%20Doe&membership_level=Gold&email=john@email.com&source=flutter_app
```
Check the **Customers** page in Shopify Admin to verify the profile is created.
