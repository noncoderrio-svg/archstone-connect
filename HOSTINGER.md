# Putting Archstone Connect on Hostinger

These steps are for Hostinger web hosting with Node.js Web Apps (Business, Cloud or Unlimited plans).

## 1. Create the app

1. In hPanel, go to **Websites → Create site → Web App**.
2. Upload `Archstone-Connect-source.zip`, or connect the GitHub repository.
3. Use these build settings:
   - **Framework:** Express (or Other)
   - **Node.js version:** 24 (or 22, if 24 is not offered)
   - **Root directory:** leave empty (`package.json` is at the top of the ZIP)
   - **Entry file:** `server.js`
   - **Install command:** `npm install`
   - **Build command:** `npm run build`
   - **Start command:** `npm start`
   - **Output folder:** `dist`, if Hostinger asks for one

## 2. Environment variables

Add these in the app's **Environment variables** settings:

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_URL` | Your address, for example `https://crm.yourdomain.com` |
| `SECURE_COOKIES` | `true` |
| `DEMO_MODE` | `false` (a live system refuses to start with demo data) |
| `INITIAL_ADMIN_EMAIL` | Your email address |
| `INITIAL_ADMIN_PASSWORD` | A strong first password, which you change at first sign-in |
| `DB_PATH` | A folder **outside** the app folder, for example `/home/u123456789/archstone-data/archstone-connect.db` |
| `CRON_TOKEN` | A long random value, for example 40 random letters and numbers |

`DB_PATH` matters most. The database, uploaded files, the encryption key and daily backups are all stored in that folder. If the folder sits inside the app folder, a redeploy can delete your data. Your home folder name (`u123456789`) is shown in hPanel under **File Manager**.

Leave the WhatsApp, Meta, Gemini, Exotel, Google and email settings out. You set them later in the app, under **Settings → Integrations**, where they are stored encrypted.

## 3. Wake-up cron job (important)

Hostinger may pause the app when nobody is using it. While it is paused, nothing else runs: follow-up reminders, scheduled broadcasts, lead alerts and daily backups. A cron job fixes this by waking the app every minute.

1. In hPanel, open **Advanced → Cron Jobs**.
2. Add a **custom command** that runs **every minute**:

   ```
   curl -fsS "https://crm.yourdomain.com/cron/tick?token=YOUR_CRON_TOKEN" > /dev/null
   ```

3. Replace the address and `YOUR_CRON_TOKEN` with your own values.

Without the right token, the link answers "Not found", so nobody else can trigger it.

## 4. Domain

Point a domain or subdomain, such as `crm.yourdomain.com`, at the web app in hPanel, and turn on the free SSL certificate. Keep `APP_URL` set to that address.

## Limits on shared hosting

- **Live updates:** the screen refreshes over one long-running connection. Hostinger closes requests after 120 seconds, so the app reconnects every two minutes. You will not notice this.
- **Uploads and exports:** very large uploads, exports or backup downloads must finish within 120 seconds.
- **Backups:** daily backups are kept on the same disk as your data. Download one each week from **Settings** and keep it elsewhere. The app reminds admins to do this.
- **VPS:** if the team grows large or reminders arrive late, move to a Hostinger VPS. The same code runs there unchanged.
